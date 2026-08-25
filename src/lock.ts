/**
 * A cross-process lock over provisioning.
 *
 * Provisioning writes into one shared virtualenv and one shared asset cache, so
 * two of them at once is not merely wasteful — concurrent downloads into the
 * same cache files can leave a half-written model behind. Two provisioners is
 * not hypothetical: a running harness bootstraps on activation while the
 * operator may separately run `scripts/setup.mjs`, and two harness instances
 * can start at once.
 *
 * The lock is a file created exclusively. A lock older than {@link STALE_MS} is
 * assumed abandoned (the holder was killed) and taken over, because a permanent
 * lock would be worse than a rare duplicate.
 */

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** After this long, a lock is treated as abandoned rather than held. */
export const STALE_MS = 2 * 60 * 60_000

export interface LockHandle {
  /** Release the lock. Safe to call twice. */
  release(): Promise<void>
}

export interface LockStatus {
  held: true
  /** Process that holds it, as recorded in the lock file. */
  pid: number
  ageMs: number
}

/**
 * Take the provisioning lock.
 * @param path - lock file path.
 * @returns a handle when acquired, or who holds it when not.
 */
export async function acquireLock(path: string): Promise<LockHandle | LockStatus> {
  await mkdir(dirname(path), { recursive: true })
  const payload = `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // 'wx' fails when the file exists, which is what makes this a lock.
      await writeFile(path, payload, { flag: 'wx' })
      let released = false
      return {
        release: async () => {
          if (released) return
          released = true
          await rm(path, { force: true })
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    const held = await describeLock(path)
    if (held === null) continue          // vanished between write and stat; retry
    if (held.ageMs < STALE_MS) return held
    await rm(path, { force: true })      // abandoned; take it over
  }

  const held = await describeLock(path)
  return held ?? { held: true, pid: -1, ageMs: 0 }
}

/** Read a lock file's holder and age, or null when it is gone. */
async function describeLock(path: string): Promise<LockStatus | null> {
  try {
    const [info, raw] = await Promise.all([stat(path), readFile(path, 'utf8')])
    let pid = -1
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { pid?: unknown }).pid === 'number') {
        pid = (parsed as { pid: number }).pid
      }
    } catch {
      // A truncated lock file still proves someone is holding it; the pid is
      // only used for the message.
    }
    return { held: true, pid, ageMs: Date.now() - info.mtimeMs }
  } catch {
    return null
  }
}

/** Narrow the {@link acquireLock} result. */
export function isHeld(result: LockHandle | LockStatus): result is LockStatus {
  return 'held' in result
}
