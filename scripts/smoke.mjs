#!/usr/bin/env node
/**
 * End-to-end smoke test against the real SynOmega install.
 *
 * Drives the Python worker over its actual ndjson protocol — the same frames the
 * host plugin sends — so what is exercised is the real model, the real route
 * search, and the real serialization, not a fake. Prints one line per capability
 * and exits non-zero if any of them fails.
 *
 *     node scripts/smoke.mjs [--quick]
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const root = join(dirname(fileURLToPath(process.argv[1] ? `file://${process.argv[1]}` : import.meta.url)), '..')
const stateDir = join(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'), 'plugins', 'synomega')
const stamp = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'))
const quick = process.argv.includes('--quick')

const child = spawn(stamp.executable, ['-u', join(root, 'python', 'worker.py')], {
  cwd: join(root, 'python'),
  stdio: ['pipe', 'pipe', 'inherit'],
})

const lines = createInterface({ input: child.stdout })
const pending = new Map()
let ready
const readyPromise = new Promise((resolve) => { ready = resolve })

lines.on('line', (line) => {
  if (line.trim().length === 0) return
  const frame = JSON.parse(line)
  if (frame.event === 'ready') { ready(frame); return }
  const settle = pending.get(frame.id)
  if (settle === undefined) return
  pending.delete(frame.id)
  settle(frame)
})

let nextId = 1
function call(op, params) {
  const id = String(nextId++)
  return new Promise((resolve) => {
    pending.set(id, resolve)
    child.stdin.write(`${JSON.stringify({ id, op, params })}\n`)
  })
}

function report(label, frame, describe) {
  if (frame.ok !== true) {
    console.log(`FAIL  ${label}: ${frame.error?.kind} — ${frame.error?.message}`)
    return false
  }
  console.log(`ok    ${label}: ${describe(frame.data)}`)
  return true
}

const started = Date.now()
const boot = await readyPromise
console.log(`worker ready (pid ${boot.pid}, python ${boot.python})`)

const results = []
const ASPIRIN = 'CC(=O)Oc1ccccc1C(=O)O'
// Paracetamol is the *para* isomer; CC(=O)Nc1ccccc1O is 2-acetamidophenol.
const PARACETAMOL = 'CC(=O)Nc1ccc(O)cc1'

results.push(report('status', await call('status', {}), (d) => `synomega ${d.version}, installed=${d.installed}`))

results.push(report('retro   (single-step retrosynthesis)', await call('retro', { product: PARACETAMOL, top_k: 5 }),
  (d) => `${d.predictions.length} disconnection(s); best ${d.predictions[0]?.reaction_smiles} @ ${d.predictions[0]?.score}`))

results.push(report('forward (single-step forward)', await call('forward', { reactants: 'CC(=O)O.Nc1ccc(O)cc1', top_k: 3 }),
  (d) => `${d.products.length} product(s); best ${d.products[0]?.product} @ ${d.products[0]?.score}`))

// A rejection is the pass condition here, so it gets its own check rather than
// being counted as a failure that happens to be expected.
{
  const frame = await call('retro', { product: 'not-a-molecule((' })
  const rejected = frame.ok === false && frame.error?.kind === 'invalid_smiles'
  console.log(rejected
    ? 'ok    invalid SMILES is rejected: invalid_smiles'
    : `FAIL  invalid SMILES was not rejected: ${JSON.stringify(frame).slice(0, 160)}`)
  results.push(rejected)
}

if (!quick) {
  results.push(report('plan    (multi-step route)', await call('plan', { target: PARACETAMOL, max_depth: 4, max_routes: 2, time_limit: 60 }),
    (d) => `solved=${d.solved}, ${d.num_routes_found} route(s), ${d.stats.expansions} expansions, stopped by ${d.stats.terminated_by}`))

  results.push(report('score   (SynScore)', await call('score', { target: ASPIRIN, max_steps: 4, time_limit: 60 }),
    (d) => `score=${d.score}, solved=${d.solved}, ${d.min_steps} step(s), coverage ${d.bb_coverage}`))

  results.push(report('evolve  (multi-component)', await call('evolve', { reactants: 'CC(=O)c1ccccc1.C=O.CNC', max_depth: 2, top: 5 }),
    (d) => `${d.num_molecules} molecule(s), ${d.num_reaction_edges} edge(s); best ${d.molecules[0]?.smiles} @ ${d.molecules[0]?.total_score}`))
}

child.stdin.write(`${JSON.stringify({ id: 'bye', op: 'shutdown' })}\n`)
child.stdin.end()

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} checks passed in ${((Date.now() - started) / 1000).toFixed(1)}s`)
process.exit(passed === results.length ? 0 : 1)
