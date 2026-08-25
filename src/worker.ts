/**
 * Bridge to the resident Python worker.
 *
 * One child process, one request in flight at a time, newline-delimited JSON in
 * both directions. Requests queue on this side because SynOmega's inference is
 * not thread-safe and concurrent calls would only make each other slower.
 *
 * Cancellation is the honest weak spot: Python inference cannot be interrupted
 * cooperatively. An aborted call is *abandoned* — its caller settles at once and
 * the eventual reply is dropped. If an abandoned call has not returned within
 * `hardKillMs`, the worker is killed and respawned, because a wedged process
 * would otherwise block every later request.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { Config } from './config.ts'

/** Resolved interpreter and environment for the worker process. */
export interface PythonEnvironment {
  /** Absolute path to a Python >= 3.10 interpreter. */
  executable: string
  /** Directory holding `worker.py`. */
  workerDir: string
  /** Extra environment entries (asset mirror, cache dir). */
  env: NodeJS.ProcessEnv
}

/** A typed failure the caller can turn into a useful message for the model. */
export class WorkerError extends Error {
  /** Stable machine-readable tag, e.g. `invalid_smiles`, `timeout`, `busy`. */
  readonly kind: string
  /** Diagnostic tail (usually the child's stderr), when one is available. */
  readonly detail: string | undefined

  constructor(kind: string, message: string, detail?: string) {
    super(message)
    this.name = 'WorkerError'
    this.kind = kind
    this.detail = detail
  }
}

interface Pending {
  readonly op: string
  resolve(value: JsonValue): void
  reject(error: Error): void
  timer: NodeJS.Timeout | undefined
  abandonedAt: number | undefined
}

interface QueueEntry {
  readonly op: string
  readonly params: JsonValue
  readonly timeoutMs: number
  readonly signal: AbortSignal
  resolve(value: JsonValue): void
  reject(error: Error): void
}

/** How many consecutive spawn failures trip the breaker. */
const SPAWN_FAILURE_LIMIT = 3

/** How long a freshly spawned worker has to announce itself. */
const READY_TIMEOUT_MS = 30_000

export class SynomegaWorker {
  #handle: SubprocessHandle | undefined
  #starting: Promise<SubprocessHandle> | undefined
  #buffer = ''
  #nextId = 1
  #pending = new Map<string, Pending>()
  #queue: QueueEntry[] = []
  #draining = false
  /** Requests dequeued and not yet settled, abandoned ones included: the worker is still busy with them. */
  #active = 0
  #idleTimer: NodeJS.Timeout | undefined
  #killTimer: NodeJS.Timeout | undefined
  #spawnFailures = 0
  #disposed = false
  #startupStderr = ''

  readonly #ctx: Context
  readonly #config: Config
  readonly #resolveEnvironment: () => Promise<PythonEnvironment>

  constructor(
    ctx: Context,
    config: Config,
    resolveEnvironment: () => Promise<PythonEnvironment>,
  ) {
    this.#ctx = ctx
    this.#config = config
    this.#resolveEnvironment = resolveEnvironment
  }

  /** Requests waiting for a slot; exposed for admission control and tests. */
  get queueDepth(): number {
    return this.#queue.length
  }

  /** Whether a child process is currently alive. */
  get running(): boolean {
    return this.#handle !== undefined
  }

  /**
   * Run one operation on the worker.
   * @param op - worker operation name.
   * @param params - operation parameters, already JSON-safe.
   * @param signal - caller cancellation; aborting abandons the call.
   * @param timeoutMs - cooperative deadline for this call.
   * @returns the operation's canonical value.
   */
  async call(op: string, params: JsonValue, signal: AbortSignal, timeoutMs: number): Promise<JsonValue> {
    if (this.#disposed) throw new WorkerError('unavailable', 'the SynOmega plugin is shutting down')
    // Outstanding work, not just the waiting line. A dequeued request is already
    // off the queue and not yet registered as pending, so neither collection
    // alone sees it; `#active` covers that window.
    const outstanding = this.#queue.length + this.#active
    if (outstanding >= this.#config.queueLimit) {
      throw new WorkerError(
        'busy',
        `SynOmega is busy: ${outstanding} request(s) already outstanding. Retry after the current prediction finishes.`,
      )
    }
    return await new Promise<JsonValue>((resolve, reject) => {
      this.#queue.push({ op, params, timeoutMs, signal, resolve, reject })
      void this.#drain()
    })
  }

  /** Stop the worker and fail everything outstanding. */
  async dispose(): Promise<void> {
    this.#disposed = true
    this.#clearTimer('idle')
    this.#clearTimer('kill')
    const shuttingDown = new WorkerError('unavailable', 'the SynOmega plugin was unloaded')
    for (const entry of this.#queue.splice(0)) entry.reject(shuttingDown)
    this.#failAllPending(shuttingDown)
    await this.#stop()
  }

  // ------------------------------------------------------------------ queue

  async #drain(): Promise<void> {
    if (this.#draining) return
    this.#draining = true
    try {
      while (this.#queue.length > 0 && !this.#disposed) {
        const entry = this.#queue.shift()
        if (entry === undefined) break
        if (entry.signal.aborted) {
          entry.reject(new WorkerError('aborted', 'the call was cancelled before it started'))
          continue
        }
        this.#active += 1
        try {
          await this.#run(entry)
        } finally {
          this.#active -= 1
        }
      }
    } finally {
      this.#draining = false
      this.#armIdleTimer()
    }
  }

  async #run(entry: QueueEntry): Promise<void> {
    let handle: SubprocessHandle
    try {
      // Starting the child is part of the caller's wait: a worker that never
      // announces itself must not hold a caller past its own deadline.
      handle = await this.#startWithin(entry)
    } catch (error) {
      entry.reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    const id = String(this.#nextId++)
    const settled = new Promise<JsonValue>((resolve, reject) => {
      const pending: Pending = { op: entry.op, resolve, reject, timer: undefined, abandonedAt: undefined }
      pending.timer = setTimeout(() => {
        this.#abandon(id, new WorkerError(
          'timeout',
          `${entry.op} exceeded ${Math.round(entry.timeoutMs / 1000)}s. Try a smaller max_depth / max_steps, or raise the timeout in the plugin config.`,
        ))
      }, entry.timeoutMs)
      this.#pending.set(id, pending)
    })

    const onAbort = (): void => {
      this.#abandon(id, new WorkerError('aborted', `${entry.op} was cancelled`))
    }
    entry.signal.addEventListener('abort', onAbort, { once: true })

    try {
      handle.stdin?.write(`${JSON.stringify({ id, op: entry.op, params: entry.params })}\n`)
      entry.resolve(await settled)
    } catch (error) {
      entry.reject(error instanceof Error ? error : new Error(String(error)))
    } finally {
      entry.signal.removeEventListener('abort', onAbort)
    }
  }

  /** Await the child's readiness, bounded by this caller's deadline and signal. */
  async #startWithin(entry: QueueEntry): Promise<SubprocessHandle> {
    let timer: NodeJS.Timeout | undefined
    const bound = new Promise<never>((_resolve, reject) => {
      const fail = (error: WorkerError): void => reject(error)
      timer = setTimeout(() => fail(new WorkerError(
        'timeout',
        `the SynOmega Python worker did not become ready within ${Math.round(entry.timeoutMs / 1000)}s`,
      )), entry.timeoutMs)
      timer.unref?.()
      entry.signal.addEventListener(
        'abort',
        () => fail(new WorkerError('aborted', `${entry.op} was cancelled while the worker was starting`)),
        { once: true },
      )
    })
    try {
      return await Promise.race([this.#ensureStarted(), bound])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Settle a caller now and stop waiting for the reply. The worker keeps
   * computing; its answer is dropped when it arrives.
   */
  #abandon(id: string, error: WorkerError): void {
    const pending = this.#pending.get(id)
    if (pending === undefined || pending.abandonedAt !== undefined) return
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    pending.timer = undefined
    pending.abandonedAt = Date.now()
    pending.reject(error)
    this.#armKillTimer()
  }

  #failAllPending(error: Error): void {
    for (const [id, pending] of this.#pending) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      this.#pending.delete(id)
      if (pending.abandonedAt === undefined) pending.reject(error)
    }
  }

  // ----------------------------------------------------------------- process

  async #ensureStarted(): Promise<SubprocessHandle> {
    if (this.#handle !== undefined) return this.#handle
    if (this.#starting !== undefined) return await this.#starting
    if (this.#spawnFailures >= SPAWN_FAILURE_LIMIT) {
      throw new WorkerError(
        'unavailable',
        `the SynOmega Python worker failed to start ${this.#spawnFailures} times in a row; it will not be retried until the plugin reloads`,
        this.#startupStderr,
      )
    }
    this.#starting = this.#start()
    try {
      return await this.#starting
    } finally {
      this.#starting = undefined
    }
  }

  async #start(): Promise<SubprocessHandle> {
    const environment = await this.#resolveEnvironment()
    let handle: SubprocessHandle
    try {
      handle = this.#ctx.subprocess.spawn({
        argv: [environment.executable, '-u', `${environment.workerDir}/worker.py`],
        cwd: environment.workerDir,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 64 * 1024 } },
        graceMs: 5_000,
        env: environment.env,
      })
    } catch (error) {
      this.#spawnFailures += 1
      throw new WorkerError('unavailable', `could not start the SynOmega Python worker: ${String(error)}`)
    }

    handle.stdout?.setEncoding('utf8')
    handle.stdout?.on('data', (chunk: string) => this.#onStdout(chunk))
    void handle.done.then(
      (outcome) => {
        const how = outcome.signal !== null
          ? `was killed by ${outcome.signal}`
          : `exited with code ${String(outcome.exitCode)}`
        this.#onExit(how, handle)
      },
      (error: unknown) => this.#onExit(`failed to spawn: ${String(error)}`, handle),
    )

    this.#handle = handle
    // The worker announces itself before reading any request; waiting for that
    // line turns "interpreter is broken" into a spawn failure instead of a
    // request timeout minutes later.
    try {
      await this.#waitForReady(handle)
    } catch (error) {
      this.#spawnFailures += 1
      this.#startupStderr = this.#readStderr(handle)
      handle.terminate()
      this.#handle = undefined
      throw error
    }
    this.#spawnFailures = 0
    return handle
  }

  /**
   * The child's stderr tail, for attaching to a failure message. Diagnostics are
   * collected in memory only (no spill file): a wedged interpreter's last words
   * are worth reporting, a full transcript is not worth a file.
   */
  #readStderr(handle: SubprocessHandle): string {
    try {
      return handle.collected.stderr?.readFrom(0).text.trim() ?? ''
    } catch {
      return ''
    }
  }

  /**
   * Wait for the worker's `ready` line. Blocking here converts "the interpreter
   * is broken" into a spawn failure now, instead of a request timeout minutes
   * later with no interpreter diagnostics attached.
   */
  async #waitForReady(handle: SubprocessHandle): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new WorkerError(
          'unavailable',
          'the SynOmega Python worker did not report ready within 30s',
          this.#readStderr(handle),
        ))
      }, READY_TIMEOUT_MS)
      timer.unref?.()
    })
    try {
      await Promise.race([this.#ready, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  #readyResolve: (() => void) | undefined
  #ready: Promise<void> = new Promise<void>((resolve) => { this.#readyResolve = resolve })

  #onStdout(chunk: string): void {
    this.#buffer += chunk
    let index = this.#buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim()
      this.#buffer = this.#buffer.slice(index + 1)
      if (line.length > 0) this.#onFrame(line)
      index = this.#buffer.indexOf('\n')
    }
  }

  #onFrame(line: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch {
      // A malformed frame means the protocol stream is untrustworthy: something
      // in the child printed to stdout. Say so rather than silently dropping it.
      this.#ctx.logger?.warn?.('synomega worker emitted a non-JSON line: %s', line.slice(0, 200))
      return
    }
    if (typeof frame !== 'object' || frame === null) return
    const record = frame as Record<string, unknown>
    if (record['event'] === 'ready') {
      this.#readyResolve?.()
      return
    }
    const id = typeof record['id'] === 'string' ? record['id'] : undefined
    if (id === undefined) return
    const pending = this.#pending.get(id)
    if (pending === undefined) return
    this.#pending.delete(id)
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    if (pending.abandonedAt !== undefined) {
      // The caller is long gone; the only thing this reply changes is that the
      // worker is provably healthy, so cancel the pending hard kill.
      this.#maybeClearKillTimer()
      return
    }
    if (record['ok'] === true) {
      pending.resolve((record['data'] ?? null) as JsonValue)
      return
    }
    const error = (record['error'] ?? {}) as Record<string, unknown>
    pending.reject(new WorkerError(
      typeof error['kind'] === 'string' ? error['kind'] : 'internal',
      typeof error['message'] === 'string' ? error['message'] : 'the SynOmega worker reported an unspecified failure',
    ))
  }

  #onExit(reason: string, handle: SubprocessHandle): void {
    const stderr = this.#readStderr(handle)
    this.#handle = undefined
    this.#buffer = ''
    this.#ready = new Promise<void>((resolve) => { this.#readyResolve = resolve })
    this.#clearTimer('kill')
    this.#failAllPending(new WorkerError(
      'unavailable',
      `the SynOmega Python worker ${reason}`,
      stderr,
    ))
  }

  async #stop(): Promise<void> {
    const handle = this.#handle
    if (handle === undefined) return
    this.#handle = undefined
    const deadline = AbortSignal.timeout(this.#config.hardKillMs)
    try {
      handle.stdin?.write(`${JSON.stringify({ id: 'shutdown', op: 'shutdown' })}\n`)
      handle.stdin?.end()
      // A clean shutdown only gets until the hard-kill deadline: a child stuck
      // inside model inference must not hold the plugin's teardown open.
      await handle.waitForExit(deadline)
    } catch {
      // Terminating below is the point; the reason it did not exit politely
      // does not change what happens next.
    } finally {
      handle.terminate()
    }
  }

  // ------------------------------------------------------------------ timers

  #armIdleTimer(): void {
    this.#clearTimer('idle')
    const idle = this.#config.workerIdleTimeoutMs
    if (idle <= 0 || this.#handle === undefined) return
    this.#idleTimer = setTimeout(() => {
      if (this.#pending.size === 0 && this.#queue.length === 0) void this.#stop()
    }, idle)
    this.#idleTimer.unref?.()
  }

  #armKillTimer(): void {
    if (this.#killTimer !== undefined) return
    this.#killTimer = setTimeout(() => {
      this.#killTimer = undefined
      if (this.#hasAbandoned()) {
        this.#ctx.logger?.warn?.('synomega worker still busy with an abandoned call; restarting it')
        void this.#stop()
      }
    }, this.#config.hardKillMs)
    this.#killTimer.unref?.()
  }

  #maybeClearKillTimer(): void {
    if (!this.#hasAbandoned()) this.#clearTimer('kill')
  }

  #hasAbandoned(): boolean {
    for (const pending of this.#pending.values()) {
      if (pending.abandonedAt !== undefined) return true
    }
    return false
  }

  #clearTimer(which: 'idle' | 'kill'): void {
    const timer = which === 'idle' ? this.#idleTimer : this.#killTimer
    if (timer !== undefined) clearTimeout(timer)
    if (which === 'idle') this.#idleTimer = undefined
    else this.#killTimer = undefined
  }
}
