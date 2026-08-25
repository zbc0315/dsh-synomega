/**
 * Provisioning and serving the molecule editor.
 *
 * The archive is synthesized rather than downloaded — 35 MB per test run would
 * be absurd, and what needs pinning is not Ketcher's contents but this
 * plugin's handling of them: that the three unused demo entry points (88 MB of
 * the real archive) are dropped, that a request cannot walk out of the
 * extraction root, and that a request arriving before the editor is installed
 * gets an answer a dialog can display instead of a broken frame.
 */

import { ok, strictEqual } from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  KetcherAssets, commonDirectory, createKetcherHandler, defaultArchiveUrl, extractApp, resolveWithin,
} from '../src/ketcher.ts'
import { KETCHER_ROUTE, KETCHER_STATE_PATH } from '../src/shared/ketcher.ts'
import type { Config } from '../src/config.ts'
import { makeZip } from './support/make-zip.ts'

function config(overrides: Partial<Config['ketcher']> = {}): Config {
  return { ketcher: { enabled: true, prefetch: false, version: '3.17.0', ...overrides } } as Config
}

/** The shape of the real release: one wrapping directory, four demo entries. */
function releaseArchive(): Buffer {
  return makeZip([
    { name: 'standalone/index.html', body: '<!doctype html><script src="./static/js/main.js"></script>' },
    { name: 'standalone/static/js/main.js', body: 'the editor' },
    { name: 'standalone/static/css/main.css', body: 'body{}' },
    { name: 'standalone/duo.html', body: 'a second copy' },
    { name: 'standalone/static/js/duo.abc.js', body: 'a second copy of the editor' },
    { name: 'standalone/popup.html', body: 'a third copy' },
    { name: 'standalone/static/js/closable.abc.js', body: 'a fourth copy' },
    { name: '__MACOSX/standalone/._index.html', body: 'resource fork' },
  ])
}

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dsh-synomega-ketcher-'))
}

/** Walk an extracted tree into sorted relative paths. */
async function tree(root: string, prefix = ''): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) found.push(...await tree(join(root, entry.name), relative))
    else found.push(relative)
  }
  return found.sort()
}

test('the wrapping directory is stripped and the unused editor copies are dropped', async () => {
  const root = join(await scratch(), 'app')
  const written = await extractApp(releaseArchive(), root)

  strictEqual(written, 3)
  strictEqual((await tree(root)).join(','), 'index.html,static/css/main.css,static/js/main.js')
  ok((await readFile(join(root, 'index.html'), 'utf8')).includes('./static/js/main.js'))
})

test('an archive without the entry document is refused rather than half-installed', async () => {
  const root = join(await scratch(), 'app')
  const archive = makeZip([{ name: 'standalone/static/js/main.js', body: 'x' }])
  let message = ''
  try { await extractApp(archive, root) } catch (error: unknown) { message = String(error) }
  ok(message.includes('no index.html'), message)
})

test('a shared leading directory is only stripped when every entry has it', () => {
  strictEqual(commonDirectory(['a/x', 'a/y/z']), 'a/')
  strictEqual(commonDirectory(['a/x', 'b/y']), '')
  strictEqual(commonDirectory(['x']), '')
  strictEqual(commonDirectory([]), '')
})

test('a request cannot walk out of the extraction root', () => {
  strictEqual(resolveWithin('/srv/app', '../secrets'), null)
  strictEqual(resolveWithin('/srv/app', 'static/../../secrets'), null)
  strictEqual(resolveWithin('/srv/app', 'static/js/main.js'), '/srv/app/static/js/main.js')
})

test('the default archive URL names the release the version asks for', () => {
  ok(defaultArchiveUrl('3.17.0').endsWith('/v3.17.0/ketcher-standalone-3.17.0.zip'))
})

/** Serve one handler on a loopback port for the duration of `body`. */
async function serving(handler: ReturnType<typeof createKetcherHandler>, body: (base: string) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  try {
    await body(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  } finally {
    await new Promise((done) => server.close(done))
  }
}

test('the state route answers something the dialog can display, in every phase', async () => {
  const disabled = new KetcherAssets({} as never, config({ enabled: false }), await scratch())
  await serving(createKetcherHandler(disabled), async (base) => {
    const state = await (await fetch(base + KETCHER_STATE_PATH)).json() as { phase: string }
    strictEqual(state.phase, 'disabled')
    strictEqual((await fetch(`${base}${KETCHER_ROUTE}/index.html`)).status, 404)
  })
})

test('an asset request before the editor is installed says so instead of 404ing', async () => {
  const stateDir = await scratch()
  // A URL that cannot resolve keeps the test offline; the phase is what matters.
  const assets = new KetcherAssets({} as never, config({ url: 'http://127.0.0.1:1/ketcher.zip' }), stateDir)
  await serving(createKetcherHandler(assets), async (base) => {
    const response = await fetch(`${base}${KETCHER_ROUTE}/index.html`)
    strictEqual(response.status, 503)
    ok((await response.text()).includes('not installed yet'))
  })
})

test('a local archive can stand in for the download, for a machine with no network', async () => {
  const stateDir = await scratch()
  const archivePath = join(stateDir, 'ketcher.zip')
  await writeFile(archivePath, releaseArchive())

  const assets = new KetcherAssets({} as never, config({ url: pathToFileURL(archivePath).href }), stateDir)
  await assets.ensure()

  strictEqual(assets.describe().phase, 'ready')
  strictEqual((await tree(assets.root)).join(','), '.ready.json,index.html,static/css/main.css,static/js/main.js')
})

test('an installed editor is served with a type, an etag, and a 304 on revalidation', async () => {
  const stateDir = await scratch()
  const assets = new KetcherAssets({} as never, config(), stateDir)
  await extractApp(releaseArchive(), assets.root)
  await writeFile(join(assets.root, '.ready.json'), '{}\n')
  await assets.ensure()
  strictEqual(assets.describe().phase, 'ready')

  await serving(createKetcherHandler(assets), async (base) => {
    const document_ = await fetch(`${base}${KETCHER_ROUTE}/index.html`)
    strictEqual(document_.status, 200)
    strictEqual(document_.headers.get('content-type'), 'text/html; charset=utf-8')
    strictEqual(document_.headers.get('cache-control'), 'no-cache')
    ok((await document_.text()).includes('<!doctype html>'))

    // The bare prefix is the entry document, so a frame can point at either.
    strictEqual((await fetch(`${base}${KETCHER_ROUTE}`)).status, 200)

    const script = await fetch(`${base}${KETCHER_ROUTE}/static/js/main.js`)
    strictEqual(script.headers.get('content-type'), 'text/javascript; charset=utf-8')
    strictEqual(script.headers.get('cache-control'), 'public, max-age=31536000, immutable')
    const etag = script.headers.get('etag')
    ok(etag !== null)

    const again = await fetch(`${base}${KETCHER_ROUTE}/static/js/main.js`, { headers: { 'if-none-match': etag } })
    strictEqual(again.status, 304)

    strictEqual((await fetch(`${base}${KETCHER_ROUTE}/static/js/absent.js`)).status, 404)

    // An escaped separator is the traversal a normalizing client can still
    // deliver: the path only becomes `../..` after this handler decodes it.
    strictEqual((await fetch(`${base}${KETCHER_ROUTE}/..%2f..%2fetc%2fpasswd`)).status, 403)
    strictEqual((await fetch(`${base}/somewhere/else`)).status, 404)
  })
})
