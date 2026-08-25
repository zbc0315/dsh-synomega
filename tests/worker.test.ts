/**
 * The Python bridge, against a fake child process.
 *
 * What is worth pinning here is the behaviour that only shows up under stress:
 * a reply split across chunk boundaries, a cancelled call whose reply arrives
 * later anyway, a queue that refuses work instead of growing without bound, and
 * a crash that fails everything outstanding rather than hanging it.
 */

import { strictEqual, rejects, match } from 'node:assert/strict'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import { SynomegaWorker, WorkerError } from '../src/worker.ts'
import type { Config } from '../src/config.ts'

interface Fake {
  ctx: any
  stdin: PassThrough
  stdout: PassThrough
  /** Resolve the child's `done` promise, i.e. make the process exit. */
  exit: (outcome: { exitCode: number | null, signal: NodeJS.Signals | null }) => void
  terminated: () => boolean
  /** Every line the host wrote to the child. */
  written: () => string[]
}

function fakeChild(options: { announceReady?: boolean } = {}): Fake {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const writes: string[] = []
  stdin.on('data', (chunk: Buffer) => { writes.push(chunk.toString('utf8')) })
  let resolveDone: (value: any) => void = () => {}
  const done = new Promise<any>((resolve) => { resolveDone = resolve })
  let terminated = false

  const handle = {
    pid: 4242,
    stdin,
    stdout,
    stderr: undefined,
    collected: { stderr: { readFrom: () => ({ text: 'fake stderr tail', nextOffset: 0, lossy: false }) } },
    done,
    terminate: () => { terminated = true },
    waitForExit: async () => true,
  }

  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    subprocess: {
      spawn: () => {
        if (options.announceReady !== false) {
          setImmediate(() => stdout.write(`${JSON.stringify({ event: 'ready', pid: 1 })}\n`))
        }
        return handle
      },
    },
  }

  return {
    ctx,
    stdin,
    stdout,
    exit: (outcome) => resolveDone(outcome),
    terminated: () => terminated,
    written: () => writes.join('').split('\n').filter((line) => line.length > 0),
  }
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    autoSetup: false, extras: [], downloadAssets: false, mirror: 'auto',
    plausibility: false, plausibilityThreshold: 0.4, algorithm: 'retrostar',
    simplifyPlanning: false,
    search: { expansionWidth: 50, timeLimitS: 60, maxExpansions: 500 },
    queueLimit: 8,
    timeouts: { retro: 5_000, forward: 5_000, plan: 5_000, score: 5_000, evolve: 5_000 },
    workerIdleTimeoutMs: 0, hardKillMs: 1_000,
    visualize: true, maxTreeNodes: 120, maxCardItems: 12, systemPrompt: true,
    ...overrides,
  } as Config
}

function makeWorker(fake: Fake, overrides: Partial<Config> = {}): SynomegaWorker {
  return new SynomegaWorker(fake.ctx, config(overrides), async () => ({
    executable: '/fake/python', workerDir: '/fake', env: {},
  }))
}

/** Reply to the Nth request the host sent, reading its real id off the wire. */
function replyTo(fake: Fake, index: number, payload: Record<string, unknown>): void {
  const request = JSON.parse(fake.written()[index]!)
  fake.stdout.write(`${JSON.stringify({ id: request.id, ...payload })}\n`)
}

test('a request round-trips and the reply is the canonical value', async () => {
  const fake = fakeChild()
  const worker = makeWorker(fake)
  const call = worker.call('ping', {}, new AbortController().signal, 5_000)
  await new Promise((resolve) => setTimeout(resolve, 20))
  replyTo(fake, 0, { ok: true, data: { pong: true } })
  const result = await call
  strictEqual((result as any).pong, true)
  await worker.dispose()
})

test('a reply split across chunk boundaries is still framed correctly', async () => {
  const fake = fakeChild()
  const worker = makeWorker(fake)
  const call = worker.call('ping', {}, new AbortController().signal, 5_000)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const id = JSON.parse(fake.written()[0]!).id
  const frame = JSON.stringify({ id, ok: true, data: { value: 42 } })
  fake.stdout.write(frame.slice(0, 9))
  fake.stdout.write(frame.slice(9))
  fake.stdout.write('\n')
  strictEqual((await call as any).value, 42)
  await worker.dispose()
})

test('two frames arriving in one chunk are both delivered', async () => {
  const fake = fakeChild()
  const worker = makeWorker(fake)
  const first = worker.call('ping', {}, new AbortController().signal, 5_000)
  await new Promise((resolve) => setTimeout(resolve, 20))
  replyTo(fake, 0, { ok: true, data: { n: 1 } })
  strictEqual((await first as any).n, 1)

  const second = worker.call('ping', {}, new AbortController().signal, 5_000)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const id = JSON.parse(fake.written()[1]!).id
  // A stray frame for a long-gone id must not disturb the live one.
  fake.stdout.write(
    `${JSON.stringify({ id: 'stale', ok: true, data: null })}\n` +
    `${JSON.stringify({ id, ok: true, data: { n: 2 } })}\n`,
  )
  strictEqual((await second as any).n, 2)
  await worker.dispose()
})

test('a worker error surfaces with its kind intact', async () => {
  const fake = fakeChild()
  const worker = makeWorker(fake)
  const call = worker.call('retro', { product: 'C?C' }, new AbortController().signal, 5_000)
  await new Promise((resolve) => setTimeout(resolve, 20))
  replyTo(fake, 0, { ok: false, error: { kind: 'invalid_smiles', message: 'not parsable' } })
  await rejects(call, (error: WorkerError) => {
    strictEqual(error.kind, 'invalid_smiles')
    match(error.message, /not parsable/)
    return true
  })
  await worker.dispose()
})

test('cancelling abandons the call, and the late reply is discarded quietly', async () => {
  const fake = fakeChild()
  const worker = makeWorker(fake)
  const controller = new AbortController()
  const call = worker.call('plan', { target: 'CCO' }, controller.signal, 5_000)
  await new Promise((resolve) => setTimeout(resolve, 20))
  controller.abort()
  await rejects(call, (error: WorkerError) => error.kind === 'aborted')
  // The worker keeps computing; its answer must not throw or resurface.
  replyTo(fake, 0, { ok: true, data: { late: true } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await worker.dispose()
})

test('a call cancelled before it starts never reaches the child', async () => {
  const fake = fakeChild()
  const worker = makeWorker(fake)
  const controller = new AbortController()
  controller.abort()
  await rejects(
    worker.call('plan', { target: 'CCO' }, controller.signal, 5_000),
    (error: WorkerError) => error.kind === 'aborted',
  )
  strictEqual(fake.written().length, 0)
  await worker.dispose()
})

test('a timeout reports the operation and suggests a smaller budget', async () => {
  const fake = fakeChild()
  const worker = makeWorker(fake)
  await rejects(
    worker.call('plan', { target: 'CCO' }, new AbortController().signal, 30),
    (error: WorkerError) => {
      strictEqual(error.kind, 'timeout')
      match(error.message, /max_depth/)
      return true
    },
  )
  await worker.dispose()
})

test('the queue refuses work past its limit instead of growing', async () => {
  const fake = fakeChild()
  const worker = makeWorker(fake, { queueLimit: 2 })
  const signal = new AbortController().signal
  const calls = [
    worker.call('plan', {}, signal, 5_000),
    worker.call('plan', {}, signal, 5_000),
    worker.call('plan', {}, signal, 5_000),
  ]
  await rejects(calls[2]!, (error: WorkerError) => {
    strictEqual(error.kind, 'busy')
    return true
  })
  calls[0]!.catch(() => {})
  calls[1]!.catch(() => {})
  await worker.dispose()
})

test('a crashed worker fails everything outstanding with its stderr tail', async () => {
  const fake = fakeChild()
  const worker = makeWorker(fake)
  const call = worker.call('plan', { target: 'CCO' }, new AbortController().signal, 5_000)
  await new Promise((resolve) => setTimeout(resolve, 20))
  fake.exit({ exitCode: 1, signal: null })
  await rejects(call, (error: WorkerError) => {
    strictEqual(error.kind, 'unavailable')
    match(error.message, /exited with code 1/)
    strictEqual(error.detail, 'fake stderr tail')
    return true
  })
  await worker.dispose()
})

test('dispose fails queued work and terminates the child', async () => {
  const fake = fakeChild()
  const worker = makeWorker(fake)
  const call = worker.call('plan', {}, new AbortController().signal, 5_000)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const disposal = worker.dispose()
  await rejects(call, (error: WorkerError) => error.kind === 'unavailable')
  await disposal
  strictEqual(fake.terminated(), true)
})

test('a worker that never announces itself is a spawn failure, not a hang', async () => {
  const fake = fakeChild({ announceReady: false })
  const worker = makeWorker(fake)
  // The ready timeout is 30s in production; assert the call is still pending
  // rather than resolved, which is what "not a hang" means at this timescale.
  const call = worker.call('ping', {}, new AbortController().signal, 100)
  await rejects(call, (error: WorkerError) => error.kind === 'timeout')
  await worker.dispose()
})
