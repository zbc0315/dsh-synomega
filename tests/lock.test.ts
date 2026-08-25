/**
 * The provisioning lock.
 *
 * What matters is the pair of failure modes: two provisioners must never run at
 * once (they share a virtualenv and an asset cache), and a lock left behind by a
 * killed process must not block provisioning forever.
 */

import { strictEqual, ok } from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, utimes, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLock, isHeld, STALE_MS } from '../src/lock.ts'

async function scratch(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'synomega-lock-')), 'setup.lock')
}

test('the first caller gets the lock and the second is told who holds it', async () => {
  const path = await scratch()
  const first = await acquireLock(path)
  ok(!isHeld(first))

  const second = await acquireLock(path)
  ok(isHeld(second))
  if (!isHeld(second)) return
  strictEqual(second.pid, process.pid)

  if (!isHeld(first)) await first.release()
})

test('releasing lets the next caller in, and releasing twice is harmless', async () => {
  const path = await scratch()
  const first = await acquireLock(path)
  if (isHeld(first)) throw new Error('expected the lock')
  await first.release()
  await first.release()
  strictEqual(existsSync(path), false)

  const second = await acquireLock(path)
  ok(!isHeld(second))
  if (!isHeld(second)) await second.release()
})

test('a lock abandoned by a dead process is taken over, not honoured forever', async () => {
  const path = await scratch()
  await writeFile(path, `${JSON.stringify({ pid: 999999, at: 'old' })}\n`)
  const old = new Date(Date.now() - STALE_MS - 60_000)
  await utimes(path, old, old)

  const taken = await acquireLock(path)
  ok(!isHeld(taken), 'a stale lock should be taken over')
  if (!isHeld(taken)) {
    // The lock file is now ours: fresh mtime, our pid.
    const info = await stat(path)
    ok(Date.now() - info.mtimeMs < 60_000)
    await taken.release()
  }
})

test('a corrupt lock file still counts as held', async () => {
  const path = await scratch()
  await writeFile(path, 'not json at all')
  const result = await acquireLock(path)
  ok(isHeld(result))
  if (isHeld(result)) strictEqual(result.pid, -1)
})
