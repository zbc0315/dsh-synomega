/**
 * The molecule editor: provisioning its assets, and serving them.
 *
 * A chemist types a name faster than a SMILES string, and draws a structure
 * faster than either. Ketcher is the editor for that, but it is a 30 MB browser
 * application — far too large to vendor into a plugin whose built output is
 * committed to git. So it is treated like the pretrained models: fetched once
 * from its own release, cached under the plugin's state directory, and served
 * from there by this harness. Nothing is downloaded until someone opens the
 * editor for the first time.
 *
 * Serving it ourselves (rather than pointing an iframe at a public URL) is what
 * makes the editor same-origin: the browser half reads the drawn structure
 * straight off the frame's `ketcher` object, with no message protocol to keep
 * in sync, and the editor keeps working on a machine with no internet.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { dirname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'
import { acquireLock, isHeld } from './lock.ts'
import { isSafeEntryName, readEntries, readEntry } from './zip.ts'
import {
  KETCHER_ROUTE, KETCHER_STATE_PATH,
  type KetcherPhase, type KetcherState,
} from './shared/ketcher.ts'

/**
 * SHA-256 of the archives this plugin was written against.
 *
 * The download is 30 MB of JavaScript that then runs on the harness's own
 * origin, so it is pinned. A version with no entry here still installs — the
 * operator asked for it by name — but the default path is verified.
 */
const KNOWN_DIGESTS: Readonly<Record<string, string>> = {
  '3.17.0': '4aab6395054bd77b1e068dbd8463f462846a7b25879117a251e5693f682275ed',
}

/** Where a release archive lives when the deployment has not said otherwise. */
export function defaultArchiveUrl(version: string): string {
  return `https://github.com/epam/ketcher/releases/download/v${version}/ketcher-standalone-${version}.zip`
}

/**
 * Copies of the same archive on hosts that are reachable where GitHub is not.
 *
 * GitHub releases are the canonical source; these are byte-identical mirrors,
 * so the pinned digest verifies a mirror exactly as it verifies the original.
 * The list is per version because a mirror URL names the file it serves.
 */
const MIRRORS: Readonly<Record<string, readonly string[]>> = {
  '3.17.0': [
    'https://git.ustc.edu.cn/-/project/9893/uploads/e3463c809d5927755c1414ba06146c69/ketcher-standalone-3.17.0.zip',
  ],
}

/** Every source to try for one version, canonical first. */
export function archiveUrls(version: string): string[] {
  return [defaultArchiveUrl(version), ...(MIRRORS[version] ?? [])]
}

/**
 * The release ships four separate demo entry points, each embedding its own
 * 30 MB copy of the editor. Only `index.html` is used, so the other three are
 * dropped: it is 88 MB of the 119 MB archive.
 */
const UNUSED_ENTRIES = ['duo.', 'popup.', 'closable.']

/** Written once extraction succeeds; its presence is what "ready" means. */
const STAMP = '.ready.json'

/** How long one source has to answer before the next one is tried. */
const CONNECT_TIMEOUT_MS = 20_000

/** How long to wait for another process that is already provisioning. */
const OTHER_PROVISIONER_WAIT_MS = 20 * 60_000

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
}

export class KetcherAssets {
  #state: KetcherState
  #promise: Promise<string> | undefined

  readonly #ctx: Context
  readonly #config: Config
  readonly #stateDir: string

  constructor(ctx: Context, config: Config, stateDir: string) {
    this.#ctx = ctx
    this.#config = config
    this.#stateDir = stateDir
    this.#state = config.ketcher.enabled
      ? { phase: 'idle', detail: 'not downloaded yet', version: config.ketcher.version }
      : { phase: 'disabled', detail: 'the molecule editor is turned off in this deployment', version: config.ketcher.version }
  }

  /** Directory the chosen version is extracted into. */
  get root(): string {
    return join(this.#stateDir, 'ketcher', this.#config.ketcher.version)
  }

  /** Current phase — what the browser half polls while its dialog is open. */
  describe(): KetcherState {
    return { ...this.#state }
  }

  /**
   * Make the editor available, downloading and extracting it if needed.
   *
   * Concurrent callers share one attempt, and a failed attempt is not cached:
   * the usual cause is a network that will be back.
   */
  async ensure(): Promise<string> {
    if (!this.#config.ketcher.enabled) throw new Error('the molecule editor is turned off in this deployment')
    if (this.#promise === undefined) {
      this.#promise = this.#provision().catch((error: unknown) => {
        this.#promise = undefined
        const message = error instanceof Error ? error.message : String(error)
        this.#state = { ...this.#state, phase: 'failed', detail: message }
        throw error
      })
    }
    return await this.#promise
  }

  /** Kick provisioning off without waiting for it; failures land in {@link describe}. */
  start(): void {
    if (!this.#config.ketcher.enabled || !this.#config.ketcher.prefetch) return
    void this.ensure().catch((error: unknown) => {
      this.#ctx.logger?.warn?.('synomega: ketcher prefetch failed: %s', String(error))
    })
  }

  async #provision(): Promise<string> {
    if (existsSync(join(this.root, STAMP))) {
      this.#state = { ...this.#state, phase: 'ready', detail: 'ready' }
      return this.root
    }

    const lockPath = join(this.#stateDir, 'ketcher', 'provision.lock')
    const lock = await acquireLock(lockPath)
    if (isHeld(lock)) {
      this.#state = { ...this.#state, phase: 'downloading', detail: `another process (pid ${lock.pid}) is installing the editor` }
      await this.#awaitOtherProvisioner()
      this.#state = { ...this.#state, phase: 'ready', detail: 'ready' }
      return this.root
    }

    try {
      await this.#provisionLocked()
      return this.root
    } finally {
      await lock.release()
    }
  }

  async #provisionLocked(): Promise<void> {
    // Another process may have finished between the readiness check and the lock.
    if (existsSync(join(this.root, STAMP))) {
      this.#state = { ...this.#state, phase: 'ready', detail: 'ready' }
      return
    }

    const version = this.#config.ketcher.version
    // An explicit url is the operator's choice and stands alone; the default
    // walks the canonical source and then its mirrors.
    const candidates = this.#config.ketcher.url === undefined ? archiveUrls(version) : [this.#config.ketcher.url]
    this.#state = { ...this.#state, phase: 'downloading', detail: `downloading Ketcher ${version} (about 35 MB)` }

    // Only the built-in source chain is verified: an operator-supplied url may
    // point at a repack or a local build that the upstream digest would reject.
    const expected = this.#config.ketcher.url === undefined ? KNOWN_DIGESTS[version] : undefined
    let url = candidates[0]!
    let archive: Buffer | undefined
    const failures: string[] = []
    for (const candidate of candidates) {
      try {
        const body = await download(candidate)
        if (expected !== undefined) {
          const actual = createHash('sha256').update(body).digest('hex')
          if (actual !== expected) {
            throw new Error(`did not match the pinned checksum (got ${actual})`)
          }
        }
        archive = body
        url = candidate
        break
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push(`${candidate}: ${message}`)
        this.#ctx.logger?.warn?.('synomega: Ketcher source failed, trying the next one (%s)', message)
      }
    }
    if (archive === undefined) {
      throw new Error(`downloading Ketcher ${version} failed from every source:\n${failures.join('\n')}`)
    }

    this.#state = { ...this.#state, phase: 'extracting', detail: 'unpacking the editor' }
    const written = await extractApp(archive, this.root)
    await writeFile(join(this.root, STAMP), `${JSON.stringify({ version, url, files: written, at: new Date().toISOString() }, null, 2)}\n`)
    this.#state = { ...this.#state, phase: 'ready', detail: 'ready' }
  }

  /** Poll for the other provisioner's stamp rather than duplicating its download. */
  async #awaitOtherProvisioner(): Promise<void> {
    const deadline = Date.now() + OTHER_PROVISIONER_WAIT_MS
    while (Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 2_000))
      if (existsSync(join(this.root, STAMP))) return
    }
    throw new Error('another process has been installing the editor for too long; remove the lock file to retry')
  }
}

/**
 * Fetch a release archive.
 *
 * `file:` is handled separately because Node's `fetch` refuses it, and an
 * air-gapped deployment pointing `ketcher.url` at a copy on disk is exactly
 * the case the setting exists for.
 */
async function download(url: string): Promise<Buffer> {
  if (url.startsWith('file:')) return Buffer.from(await readFile(fileURLToPath(url)))
  // A blocked host accepts the connection and then says nothing, so the mirror
  // list is only reachable if an attempt gives up on its own. The deadline
  // covers arriving at a response, not the body: 35 MB on a slow link is slow,
  // not broken.
  const abort = new AbortController()
  const deadline = setTimeout(() => { abort.abort(new Error(`no response within ${CONNECT_TIMEOUT_MS / 1000}s`)) }, CONNECT_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(url, { signal: abort.signal })
  } finally {
    clearTimeout(deadline)
  }
  if (!response.ok) throw new Error(`downloading Ketcher failed: ${response.status} ${response.statusText} (${url})`)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * Unpack the parts of a release archive the editor actually needs.
 *
 * @param archive - the downloaded zip.
 * @param root - directory to extract into; created if absent.
 * @returns how many files were written.
 */
export async function extractApp(archive: Buffer, root: string): Promise<number> {
  const entries = readEntries(archive).filter((entry) => !entry.name.endsWith('/'))
  const files = entries.filter((entry) => {
    if (!isSafeEntryName(entry.name)) return false
    const base = entry.name.slice(entry.name.lastIndexOf('/') + 1)
    // The archive from a Mac carries a parallel `__MACOSX` tree of resource forks.
    if (entry.name.startsWith('__MACOSX/') || base.startsWith('._')) return false
    return !UNUSED_ENTRIES.some((prefix) => base.startsWith(prefix))
  })

  const strip = commonDirectory(files.map((entry) => entry.name))
  if (!files.some((entry) => entry.name.slice(strip.length) === 'index.html')) {
    throw new Error('the Ketcher archive has no index.html where one was expected')
  }

  await rm(root, { recursive: true, force: true })
  let written = 0
  for (const entry of files) {
    const relative = entry.name.slice(strip.length)
    const target = join(root, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, await readEntry(archive, entry))
    written += 1
  }
  return written
}

/** The leading directory every name shares, including its slash, or ''. */
export function commonDirectory(names: readonly string[]): string {
  if (names.length === 0) return ''
  const first = names[0]!
  const slash = first.indexOf('/')
  if (slash < 0) return ''
  const candidate = first.slice(0, slash + 1)
  return names.every((name) => name.startsWith(candidate)) ? candidate : ''
}

/**
 * The HTTP handler for the editor's prefix route.
 *
 * `__state` is what the browser half polls: asking for it also starts the
 * download, so the first click on the benzene button is what pays for the
 * editor and every later one is instant.
 */
export function createKetcherHandler(assets: KetcherAssets): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      return send(res, 400, 'text/plain; charset=utf-8', 'bad request')
    }

    if (pathname === KETCHER_STATE_PATH) {
      const state = assets.describe()
      if (state.phase === 'idle' || state.phase === 'failed') {
        void assets.ensure().catch(() => { /* the phase carries the reason */ })
      }
      return send(res, 200, CONTENT_TYPES['.json']!, JSON.stringify(assets.describe()), 'no-store')
    }

    // The web server matches this handler by prefix, so this can only fail when
    // something else routed here — but the check is what makes the slice below
    // safe to reason about on its own.
    if (pathname !== KETCHER_ROUTE && !pathname.startsWith(`${KETCHER_ROUTE}/`)) {
      return send(res, 404, 'text/plain; charset=utf-8', 'not found')
    }

    const state = assets.describe()
    if (state.phase === 'disabled') return send(res, 404, 'text/plain; charset=utf-8', 'the molecule editor is turned off')
    if (state.phase !== 'ready') {
      return send(res, 503, 'text/plain; charset=utf-8', `the molecule editor is not installed yet (${state.detail})`, 'no-store')
    }

    // Percent-decoding happens after the prefix is peeled off, so an escaped
    // separator cannot forge a path that looks like it belongs to this route.
    let relative: string
    try {
      relative = decodeURIComponent(pathname.slice(KETCHER_ROUTE.length).replace(/^\/+/, ''))
    } catch {
      return send(res, 400, 'text/plain; charset=utf-8', 'bad request')
    }
    const file = resolveWithin(assets.root, relative === '' ? 'index.html' : relative)
    if (file === null) return send(res, 403, 'text/plain; charset=utf-8', 'forbidden')

    let info
    try {
      info = await stat(file)
    } catch {
      return send(res, 404, 'text/plain; charset=utf-8', 'not found')
    }
    if (!info.isFile()) return send(res, 404, 'text/plain; charset=utf-8', 'not found')

    const etag = `"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`
    // The document must be revalidated; everything else carries a content hash
    // in its own name, so it can be cached for as long as the browser likes.
    const cache = file.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000, immutable'
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': cache })
      res.end()
      return
    }

    const dot = file.lastIndexOf('.')
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[file.slice(dot).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': String(info.size),
      'Cache-Control': cache,
      ETag: etag,
      // The editor is framed by the harness's own page and nothing else.
      'Content-Security-Policy': "frame-ancestors 'self'",
      'X-Content-Type-Options': 'nosniff',
    })
    if (req.method === 'HEAD') { res.end(); return }
    await new Promise<void>((done) => {
      const stream = createReadStream(file)
      stream.on('error', () => { res.destroy(); done() })
      stream.on('close', () => { done() })
      stream.pipe(res)
    })
  }
}

/** Register the route, once the composition actually has a web server. */
export function serveKetcher(ctx: Context, assets: KetcherAssets): void {
  ctx.inject(['webServer'], (webCtx: Context) => {
    const webServer = webCtx.get('webServer') as { register(route: { kind: 'prefix', path: string, handler: (req: IncomingMessage, res: ServerResponse) => unknown }): () => void } | undefined
    if (webServer === undefined) return
    const handler = createKetcherHandler(assets)
    webCtx.effect(() => webServer.register({ kind: 'prefix', path: KETCHER_ROUTE, handler }))
  })
}

/**
 * Join a request-supplied path onto a root, or refuse.
 *
 * The containment check is on the resolved path rather than the input, so
 * `..`, a symlinked-looking name, and an absolute path all fail the same way.
 */
export function resolveWithin(root: string, relative: string): string | null {
  if (relative.includes('\0')) return null
  const base = resolve(root)
  const target = resolve(base, normalize(relative))
  return target === base || target.startsWith(base + sep) ? target : null
}

function send(res: ServerResponse, status: number, type: string, body: string, cache?: string): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': String(Buffer.byteLength(body)),
    ...cache === undefined ? {} : { 'Cache-Control': cache },
  })
  res.end(body)
}

export type { KetcherPhase, KetcherState }
export { KETCHER_ROUTE, KETCHER_STATE_PATH }
