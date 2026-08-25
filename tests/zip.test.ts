/**
 * The zip reader, against archives this test writes itself.
 *
 * Writing the archives here rather than checking one in is what makes the
 * hostile cases possible: an entry that climbs out of the extraction root, a
 * corrupted byte, an unsupported compression method. Those are the cases that
 * matter — the happy path is proved by the real Ketcher release every time
 * someone opens the editor.
 */

import { strictEqual, ok, throws, rejects } from 'node:assert/strict'
import { test } from 'node:test'
import { isSafeEntryName, readEntries, readEntry } from '../src/zip.ts'
import { makeZip } from './support/make-zip.ts'

test('entries are listed and their contents come back intact', async () => {
  const archive = makeZip([
    { name: 'standalone/index.html', body: '<!doctype html><title>Ketcher</title>' },
    { name: 'standalone/static/js/main.js', body: 'console.log(1)'.repeat(500) },
    { name: 'standalone/robots.txt', body: 'stored verbatim', store: true },
  ])
  const entries = readEntries(archive)
  strictEqual(entries.length, 3)
  strictEqual(entries.map((e) => e.name).join(','), 'standalone/index.html,standalone/static/js/main.js,standalone/robots.txt')

  strictEqual((await readEntry(archive, entries[0]!)).toString('utf8'), '<!doctype html><title>Ketcher</title>')
  strictEqual((await readEntry(archive, entries[1]!)).length, 'console.log(1)'.length * 500)
  strictEqual((await readEntry(archive, entries[2]!)).toString('utf8'), 'stored verbatim')
})

test('a flipped byte fails the checksum rather than reaching the disk', async () => {
  const archive = makeZip([{ name: 'a.txt', body: 'the original bytes', store: true }])
  const entries = readEntries(archive)
  // The stored payload sits right after the 30-byte local header and its name.
  archive[30 + 'a.txt'.length] = 0x58
  await rejects(readEntry(archive, entries[0]!), /failed its checksum/)
})

test('something that is not a zip is refused by name', () => {
  throws(() => readEntries(Buffer.alloc(400)), /not a zip archive/)
})

test('an unsupported compression method is reported, not guessed at', async () => {
  const archive = makeZip([{ name: 'a.txt', body: 'x', store: true }])
  const entries = readEntries(archive)
  await rejects(readEntry(archive, { ...entries[0]!, method: 14 }), /compression method 14/)
})

test('entry names that would escape the extraction root are rejected', () => {
  for (const bad of ['../escape', 'a/../../escape', '/absolute', 'C:\\windows', 'back\\slash', '', 'nul\0byte']) {
    strictEqual(isSafeEntryName(bad), false, `${JSON.stringify(bad)} should be refused`)
  }
  for (const good of ['index.html', 'static/js/main.js', 'a..b/c']) {
    ok(isSafeEntryName(good), `${good} should be accepted`)
  }
})
