/**
 * Provision the Python side: an interpreter, the `synomega` package, and the
 * pretrained assets.
 *
 * Everything here is idempotent and restart-safe. A stamp file records what was
 * provisioned; a later activation that finds a matching stamp does no work at
 * all. Provisioning runs in the background at activation — it must never block
 * the harness from booting — so tools ask {@link Bootstrap.describe} for the
 * current phase and report progress instead of failing.
 *
 * Note the version floor: SynOmega needs Python >= 3.10, and a machine's system
 * `python3` is frequently older. `uv` is preferred precisely because it can
 * *fetch* a suitable interpreter rather than merely finding one.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { platform } from 'node:process'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'
import type { PythonEnvironment } from './worker.ts'
import { WorkerError } from './worker.ts'
import { acquireLock, isHeld } from './lock.ts'

/** Interpreter versions acceptable to SynOmega, newest first. */
const PYTHON_CANDIDATES = ['python3.13', 'python3.12', 'python3.11', 'python3.10'] as const

/** The interpreter uv is asked to provision when none is present. */
const UV_PYTHON = '3.12'

/** Stamp format version — bump to force every install to re-provision. */
const STAMP_VERSION = 1

/** How long to wait for another process's provisioning before giving up. */
const OTHER_PROVISIONER_WAIT_MS = 30 * 60_000

export type BootstrapPhase =
  | 'idle'
  | 'resolving-python'
  | 'installing'
  | 'downloading-assets'
  | 'ready'
  | 'failed'

export interface BootstrapStatus {
  phase: BootstrapPhase
  /** One line a human (or the model) can act on. */
  detail: string
  /** Populated once provisioning failed; cleared by a retry. */
  error?: string
}

interface Stamp {
  stampVersion: number
  executable: string
  pythonVersion: string
  synomegaVersion: string
  extras: string[]
  assetsReady: boolean
  at: string
}

interface RunResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

export class Bootstrap {
  #status: BootstrapStatus = { phase: 'idle', detail: 'not started' }
  #promise: Promise<PythonEnvironment> | undefined

  readonly #ctx: Context
  readonly #config: Config
  readonly #stateDir: string
  readonly #workerDir: string

  constructor(ctx: Context, config: Config, stateDir: string, workerDir: string) {
    this.#ctx = ctx
    this.#config = config
    this.#stateDir = stateDir
    this.#workerDir = workerDir
  }

  /** Current phase, for tools that need to explain a delay rather than fail. */
  describe(): BootstrapStatus {
    return { ...this.#status }
  }

  /**
   * Resolve a usable Python environment, provisioning it if needed.
   *
   * Concurrent callers share one attempt. A failed attempt is not cached: the
   * next call retries, because the usual cause (no network, no interpreter) is
   * something the operator can fix without reloading the plugin.
   */
  async ensure(): Promise<PythonEnvironment> {
    if (this.#promise === undefined) {
      this.#promise = this.#provision().catch((error: unknown) => {
        this.#promise = undefined
        const message = error instanceof Error ? error.message : String(error)
        this.#status = { phase: 'failed', detail: 'provisioning failed', error: message }
        throw error
      })
    }
    return await this.#promise
  }

  /** Kick provisioning off without waiting for it. Failures are logged, not thrown. */
  start(): void {
    if (!this.#config.autoSetup) {
      this.#status = { phase: 'idle', detail: 'autoSetup is off; the interpreter is resolved on first use' }
      return
    }
    void this.ensure().catch((error: unknown) => {
      this.#ctx.logger?.warn?.('synomega bootstrap failed: %s', String(error))
    })
  }

  // ------------------------------------------------------------ provisioning

  async #provision(): Promise<PythonEnvironment> {
    await mkdir(this.#stateDir, { recursive: true })
    const environmentOf = (executable: string): PythonEnvironment => ({
      executable,
      workerDir: this.#workerDir,
      env: this.#assetEnvironment(),
    })

    const ready = await this.#readyStamp()
    if (ready !== null) return environmentOf(ready.executable)

    // One provisioner at a time across processes: the virtualenv and the asset
    // cache are shared, and two concurrent downloads can leave a half-written
    // model behind.
    const lock = await acquireLock(join(this.#stateDir, 'setup.lock'))
    if (isHeld(lock)) {
      this.#status = {
        phase: 'installing',
        detail: `another process (pid ${lock.pid}) is provisioning SynOmega; waiting for it`,
      }
      const finished = await this.#awaitOtherProvisioner()
      if (finished !== null) return environmentOf(finished.executable)
      throw new WorkerError(
        'setup_busy',
        `SynOmega is being provisioned by another process (pid ${lock.pid}) and has not finished yet. Retry shortly.`,
      )
    }

    try {
      return await this.#provisionLocked(environmentOf)
    } finally {
      await lock.release()
    }
  }

  /** The stamp, when it describes a usable environment. */
  async #readyStamp(): Promise<Stamp | null> {
    const stamp = await this.#readStamp()
    if (stamp === null || !existsSync(stamp.executable)) return null
    this.#status = {
      phase: 'ready',
      detail: `synomega ${stamp.synomegaVersion} on Python ${stamp.pythonVersion}`,
    }
    return stamp
  }

  /**
   * Wait for whoever holds the lock to publish a stamp.
   *
   * Bounded: a holder that dies without releasing would otherwise block every
   * later call until its lock goes stale.
   */
  async #awaitOtherProvisioner(): Promise<Stamp | null> {
    const deadline = Date.now() + OTHER_PROVISIONER_WAIT_MS
    while (Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 3_000).unref?.() })
      const ready = await this.#readyStamp()
      if (ready !== null) return ready
    }
    return null
  }

  async #provisionLocked(
    environmentOf: (executable: string) => PythonEnvironment,
  ): Promise<PythonEnvironment> {
    // Re-check under the lock: the previous holder may have just finished.
    const ready = await this.#readyStamp()
    if (ready !== null) return environmentOf(ready.executable)

    this.#status = { phase: 'resolving-python', detail: 'looking for a Python 3.10+ interpreter' }
    const executable = await this.#resolveInterpreter()

    this.#status = {
      phase: 'installing',
      detail: `installing synomega${this.#extrasSuffix()} (this can take several minutes)`,
    }
    await this.#install(executable)

    const synomegaVersion = await this.#importedVersion(executable)
    let assetsReady = false
    if (this.#config.downloadAssets) {
      this.#status = {
        phase: 'downloading-assets',
        detail: 'downloading the default model and building-block stock (a few hundred MB, once)',
      }
      assetsReady = await this.#downloadAssets(executable)
    }

    const pythonVersion = await this.#interpreterVersion(executable)
    await this.#writeStamp({
      stampVersion: STAMP_VERSION,
      executable,
      pythonVersion,
      synomegaVersion,
      extras: [...this.#config.extras],
      assetsReady,
      at: new Date().toISOString(),
    })
    this.#status = { phase: 'ready', detail: `synomega ${synomegaVersion} on Python ${pythonVersion}` }
    return environmentOf(executable)
  }

  async #resolveInterpreter(): Promise<string> {
    // An explicitly configured interpreter is used as given: the operator has
    // taken responsibility for it, so a version check here would only second-guess.
    if (this.#config.python !== undefined && this.#config.python.length > 0) {
      return this.#config.python
    }

    const venv = this.#config.venvDir ?? join(this.#stateDir, 'venv')
    const executable = venvPython(venv)
    if (existsSync(executable)) return executable

    if (await this.#hasCommand('uv')) {
      const created = await this.#run(['uv', 'venv', '--python', UV_PYTHON, venv])
      if (created.exitCode === 0 && existsSync(executable)) return executable
      this.#ctx.logger?.warn?.('uv venv failed: %s', created.stderr.slice(-2000))
    }

    for (const candidate of PYTHON_CANDIDATES) {
      if (!(await this.#hasCommand(candidate))) continue
      const created = await this.#run([candidate, '-m', 'venv', venv])
      if (created.exitCode === 0 && existsSync(executable)) return executable
    }

    throw new WorkerError(
      'no_python',
      'SynOmega needs Python 3.10 or newer and none was found. Install uv ' +
      '(https://docs.astral.sh/uv/) and reload the plugin — uv will fetch a suitable ' +
      'interpreter itself — or set the plugin\'s `python` config to an existing 3.10+ interpreter.',
    )
  }

  async #install(executable: string): Promise<void> {
    const requirement = `synomega${this.#extrasSuffix()}`
    const useUv = await this.#hasCommand('uv')
    const argv = useUv
      ? ['uv', 'pip', 'install', '--python', executable, requirement]
      : [executable, '-m', 'pip', 'install', requirement]
    // Installing torch is genuinely slow; a short timeout here would turn a
    // working setup into a permanent failure.
    const result = await this.#run(argv, 30 * 60_000)
    if (result.exitCode !== 0) {
      throw new WorkerError(
        'install_failed',
        `installing ${requirement} failed (exit ${String(result.exitCode)}). ${lastLine(result.stderr)}`,
        result.stderr.slice(-4000),
      )
    }
  }

  async #downloadAssets(executable: string): Promise<boolean> {
    // Call the CLI entry point through the interpreter rather than the console
    // script: an explicitly configured interpreter need not have one adjacent.
    const result = await this.#run(
      [executable, '-c', 'from synomega.cli import main; raise SystemExit(main(["download"]))'],
      60 * 60_000,
    )
    if (result.exitCode === 0) {
      // `synomega download` fetches the retro model and the stock but not the
      // forward model, which would otherwise download on the first forward
      // prediction — long after the user believed setup had finished.
      // Constructing it is what triggers the fetch.
      const forward = await this.#run(
        [executable, '-c', 'from synomega.forward import ForwardTemplateGNN; ForwardTemplateGNN.default()'],
        60 * 60_000,
      )
      if (forward.exitCode !== 0) {
        this.#ctx.logger?.warn?.(
          'synomega forward-model prefetch failed (exit %s); it will download on the first forward prediction. %s',
          String(forward.exitCode), lastLine(forward.stderr),
        )
      }
      return true
    }
    // A failed prefetch is not fatal: SynOmega downloads on first use anyway.
    // Reporting it and continuing beats refusing to start over a slow mirror.
    this.#ctx.logger?.warn?.(
      'synomega asset prefetch failed (exit %s); assets will download on first use instead. %s',
      String(result.exitCode), lastLine(result.stderr),
    )
    return false
  }

  async #importedVersion(executable: string): Promise<string> {
    const result = await this.#run([executable, '-c', 'import synomega; print(synomega.__version__)'])
    if (result.exitCode !== 0) {
      throw new WorkerError(
        'install_failed',
        `synomega installed but is not importable. ${lastLine(result.stderr)}`,
        result.stderr.slice(-4000),
      )
    }
    return result.stdout.trim()
  }

  async #interpreterVersion(executable: string): Promise<string> {
    const result = await this.#run([executable, '-c',
      'import sys; print("%d.%d.%d" % sys.version_info[:3])'])
    return result.exitCode === 0 ? result.stdout.trim() : 'unknown'
  }

  // ------------------------------------------------------------------ plumbing

  /** Environment entries SynOmega reads for asset resolution. */
  #assetEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    if (this.#config.mirror !== 'auto') env['SYNOMEGA_MIRROR'] = this.#config.mirror
    if (this.#config.cacheDir !== undefined) env['SYNOMEGA_CACHE'] = this.#config.cacheDir
    return env
  }

  #extrasSuffix(): string {
    const extras = this.#config.extras.filter((extra) => extra.trim().length > 0)
    return extras.length > 0 ? `[${extras.join(',')}]` : ''
  }

  async #hasCommand(command: string): Promise<boolean> {
    try {
      await this.#ctx.subprocess.resolveExecutable(command)
      return true
    } catch {
      return false
    }
  }

  async #run(argv: readonly string[], timeoutMs = 10 * 60_000): Promise<RunResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    try {
      const handle = this.#ctx.subprocess.spawn({
        argv,
        cwd: this.#stateDir,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 256 * 1024 },
          stderr: { maxBytes: 256 * 1024 },
        },
        graceMs: 5_000,
        signal: controller.signal,
        env: this.#assetEnvironment(),
      })
      const outcome = await handle.done
      return {
        exitCode: outcome.exitCode,
        stdout: handle.collected.stdout?.readFrom(0).text ?? '',
        stderr: handle.collected.stderr?.readFrom(0).text ?? '',
      }
    } catch (error) {
      return { exitCode: null, stdout: '', stderr: String(error) }
    } finally {
      clearTimeout(timer)
    }
  }

  #stampPath(): string {
    return join(this.#stateDir, 'state.json')
  }

  async #readStamp(): Promise<Stamp | null> {
    let raw: string
    try {
      raw = await readFile(this.#stampPath(), 'utf8')
    } catch {
      return null
    }
    let stamp: Stamp
    try {
      stamp = JSON.parse(raw) as Stamp
    } catch {
      return null
    }
    if (stamp.stampVersion !== STAMP_VERSION) return null
    if (!sameExtras(stamp.extras, this.#config.extras)) return null
    if (this.#config.downloadAssets && !stamp.assetsReady) return null
    return stamp
  }

  async #writeStamp(stamp: Stamp): Promise<void> {
    await writeFile(this.#stampPath(), `${JSON.stringify(stamp, null, 2)}\n`, 'utf8')
  }
}

/** Interpreter path inside a virtualenv, per platform layout. */
export function venvPython(venvDir: string): string {
  return platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python')
}

/** Extras compare as sets: order and duplicates are not meaningful to pip. */
export function sameExtras(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort()
  const b = [...new Set(right)].sort()
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function lastLine(text: string): string {
  const lines = text.trimEnd().split('\n')
  return lines[lines.length - 1]?.trim() ?? ''
}
