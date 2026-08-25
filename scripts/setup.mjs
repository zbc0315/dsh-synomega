#!/usr/bin/env node
/**
 * Install-time provisioning of the Python side.
 *
 * This is the best-effort half of setup. Package managers may refuse to run it
 * at all (pnpm >= 10 blocks build scripts until allowed), and a first-time
 * install here means a multi-minute pip download, so it must never fail the
 * install: every failure path prints one line and exits 0. The guarantee lives
 * in the plugin's activation-time bootstrap, which performs the same steps and
 * skips them when this script already wrote a matching stamp.
 *
 * Run it directly to provision without starting the harness:
 *
 *     node scripts/setup.mjs --extras gnn
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

/** Must match STAMP_VERSION in src/bootstrap.ts, or activation re-provisions. */
const STAMP_VERSION = 1
/** Must match STALE_MS in src/lock.ts. */
const LOCK_STALE_MS = 2 * 60 * 60_000
const UV_PYTHON = '3.12'
const PYTHON_CANDIDATES = ['python3.13', 'python3.12', 'python3.11', 'python3.10']

function log(message) {
  process.stdout.write(`[dsh-synomega] ${message}\n`)
}

function run(argv, options = {}) {
  return spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    stdio: options.inherit === true ? 'inherit' : 'pipe',
    timeout: options.timeoutMs ?? 30 * 60_000,
  })
}

function has(command) {
  return run([command, '--version']).status === 0
}

function dshHome() {
  const configured = process.env['DSH_HOME']
  return configured !== undefined && configured.trim().length > 0
    ? configured
    : join(homedir(), '.dsh')
}

function venvPython(venvDir) {
  return platform() === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python')
}

function parseArgs(argv) {
  const extras = []
  // `--extras ""` must mean "no extras" (the torch-free template backend), so
  // whether the flag was given is tracked separately from what it contained.
  let extrasGiven = false
  let downloadAssets = true
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--extras' && argv[i + 1] !== undefined) {
      extrasGiven = true
      extras.push(...argv[i + 1].split(',').map((part) => part.trim()).filter((part) => part.length > 0))
      i += 1
    } else if (argv[i] === '--no-extras') {
      extrasGiven = true
    } else if (argv[i] === '--no-assets') {
      downloadAssets = false
    }
  }
  return { extras: extrasGiven ? extras : ['gnn'], downloadAssets }
}

/**
 * Take the provisioning lock, mirroring src/lock.ts (the canonical implementation;
 * this file ships as plain JavaScript and cannot import the TypeScript one).
 * @returns a release function, or null when someone else is provisioning.
 */
function takeLock(path) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, { flag: 'wx' })
      return () => rmSync(path, { force: true })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    let ageMs = 0
    try {
      ageMs = Date.now() - statSync(path).mtimeMs
    } catch {
      continue
    }
    if (ageMs < LOCK_STALE_MS) return null
    rmSync(path, { force: true })
  }
  return null
}

function main() {
  const fromPostinstall = process.argv.includes('--from-postinstall')
  const { extras, downloadAssets } = parseArgs(process.argv.slice(2))

  if (fromPostinstall && process.env['DSH_SYNOMEGA_SKIP_SETUP'] === '1') {
    log('DSH_SYNOMEGA_SKIP_SETUP=1 — leaving provisioning to plugin activation.')
    return 0
  }

  const stateDir = join(dshHome(), 'plugins', 'synomega')
  const venvDir = join(stateDir, 'venv')
  const stampPath = join(stateDir, 'state.json')
  mkdirSync(stateDir, { recursive: true })

  // The virtualenv and the asset cache are shared, so two provisioners at once
  // can leave a half-written model behind. A running harness provisions on
  // activation, so this is a real collision, not a theoretical one.
  const release = takeLock(join(stateDir, 'setup.lock'))
  if (release === null) {
    log('another process is already provisioning SynOmega; leaving it to finish.')
    return 0
  }
  try {
    return provision({ stateDir, venvDir, stampPath, extras, downloadAssets })
  } finally {
    release()
  }
}

function provision({ stateDir, venvDir, stampPath, extras, downloadAssets }) {

  let executable = venvPython(venvDir)
  if (!existsSync(executable)) {
    log('creating a Python 3.10+ environment...')
    let created = false
    if (has('uv')) {
      created = run(['uv', 'venv', '--python', UV_PYTHON, venvDir], { inherit: true }).status === 0
    }
    if (!created) {
      for (const candidate of PYTHON_CANDIDATES) {
        if (!has(candidate)) continue
        created = run([candidate, '-m', 'venv', venvDir], { inherit: true }).status === 0
        if (created) break
      }
    }
    if (!created || !existsSync(executable)) {
      log('no Python 3.10+ interpreter found. Install uv (https://docs.astral.sh/uv/) '
        + 'or set the plugin\'s `python` config; the plugin will retry on activation.')
      return 0
    }
  }

  const requirement = extras.length > 0 ? `synomega[${extras.join(',')}]` : 'synomega'
  log(`installing ${requirement} (this can take several minutes)...`)
  const install = has('uv')
    ? run(['uv', 'pip', 'install', '--python', executable, requirement], { inherit: true })
    : run([executable, '-m', 'pip', 'install', requirement], { inherit: true })
  if (install.status !== 0) {
    log('install failed; the plugin will retry on activation.')
    return 0
  }

  const version = run([executable, '-c', 'import synomega; print(synomega.__version__)'])
  if (version.status !== 0) {
    log('synomega installed but is not importable; the plugin will retry on activation.')
    return 0
  }

  let assetsReady = false
  if (downloadAssets) {
    log('downloading the default model and building-block stock (a few hundred MB, once)...')
    assetsReady = run(
      [executable, '-c', 'from synomega.cli import main; raise SystemExit(main(["download"]))'],
      { inherit: true, timeoutMs: 60 * 60_000 },
    ).status === 0
    if (assetsReady) {
      // The download command covers the retro model and the stock, not the
      // forward model; constructing it is what fetches it. Doing it here means
      // "setup finished" is true for every capability, not most of them.
      log('fetching the forward model...')
      const forward = run(
        [executable, '-c', 'from synomega.forward import ForwardTemplateGNN; ForwardTemplateGNN.default()'],
        { inherit: true, timeoutMs: 60 * 60_000 },
      )
      if (forward.status !== 0) log('forward-model prefetch failed; it will download on first forward prediction.')
    } else {
      log('asset prefetch failed; SynOmega will download on first use instead.')
    }
  }

  const interpreter = run([executable, '-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'])
  writeFileSync(stampPath, `${JSON.stringify({
    stampVersion: STAMP_VERSION,
    executable,
    pythonVersion: interpreter.status === 0 ? interpreter.stdout.trim() : 'unknown',
    synomegaVersion: version.stdout.trim(),
    extras,
    assetsReady,
    at: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8')

  log(`ready: synomega ${version.stdout.trim()} at ${executable}`)
  return 0
}

try {
  process.exit(main())
} catch (error) {
  // An install must not fail because provisioning did; activation retries.
  log(`setup skipped: ${String(error)}`)
  process.exit(0)
}
