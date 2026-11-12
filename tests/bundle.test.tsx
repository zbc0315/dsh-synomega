/**
 * The published client bundle, exercised as the browser would load it.
 *
 * Every other client test imports the source. This one loads `lib/client.js` —
 * the file actually served at `/plugins/<package>/client.js` — through a
 * stand-in module loader, registers its views the way the harness does, and
 * renders one with metadata captured verbatim from a real session log. It is
 * the closest thing to a browser check that runs without a browser, and it
 * catches what source tests cannot: a broken bundle wrapper, a mis-declared
 * external, or a library that does not survive bundling.
 */

import 'global-jsdom/register'
import { ok, strictEqual } from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { render, screen, cleanup } from '@testing-library/react'
import { createElement } from 'react'

// jsdom has no canvas, and SmilesDrawer measures text with one. Making that
// explicit exercises the depiction fallback instead of filling the output with
// jsdom's "not implemented" noise.
;(globalThis as Record<string, any>)['HTMLCanvasElement'].prototype.getContext = () => null

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')
const packageName = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).name as string

/**
 * Metadata copied from a real `tool/result` event: the model called
 * `synomega_retro` on 2-acetamidophenol through a running harness, and this is
 * what the host persisted for the card.
 */
const REAL_META = {
  kind: 'retro',
  target: 'CC(=O)Nc1ccccc1O',
  shown: 3,
  total: 3,
  predictions: [
    { rank: 1, reactants: ['CC(=O)Cl', 'Nc1ccccc1O'], score: 0.136366, plausibility: null },
    { rank: 2, reactants: ['CC(=O)OC(C)=O', 'Nc1ccccc1O'], score: 0.123495, plausibility: null },
    { rank: 3, reactants: ['CC(=O)O', 'Nc1ccccc1O'], score: 0.114244, plausibility: null },
  ],
}

interface Registration { slot: string, key: string, component: (props: unknown) => unknown }

/** Load the bundle the way the browser module loader does. */
function loadBundle(): { entry: Record<string, any>, registrations: Registration[] } {
  const registrations: Registration[] = []
  let entry: Record<string, any> | undefined
  const nodeRequire = createRequire(import.meta.url)

  const globals = globalThis as Record<string, any>
  globals['window'].__ModuleLoader__ = {
    load(descriptor: { id: string, factory: (req: (name: string) => unknown) => unknown }) {
      strictEqual(descriptor.id, packageName, 'the bundle must announce the package name')
      entry = descriptor.factory((name: string) => nodeRequire(name)) as Record<string, any>
    },
  }

  // eslint-disable-next-line no-new-func -- the bundle is a script, not a module.
  new Function('window', readFileSync(bundlePath, 'utf8'))(globals['window'])
  if (entry === undefined) throw new Error('the bundle did not register an entry')

  const ctx = {
    slots: {
      inject(_name: string, declare: () => unknown) { declare() },
      register(spec: { name: string, key?: string, id?: string }, component: (props: unknown) => unknown) {
        registrations.push({ slot: spec.name, key: spec.key ?? spec.id ?? '', component })
        return () => {}
      },
    },
  }
  entry['apply'](ctx)
  return { entry, registrations }
}

test('the built bundle loads and claims the five SynOmega tool names', { skip: !existsSync(bundlePath) && 'run `npm run build` first' }, () => {
  const { entry, registrations } = loadBundle()
  strictEqual(entry['name'], 'dsh-synomega-client')
  deepEqualKeys(registrations.filter((r) => r.slot === 'tool.call.toolview').map((r) => r.key), [
    'synomega_retro', 'synomega_forward', 'synomega_plan', 'synomega_score', 'synomega_evolve',
  ])
})

test('the built bundle takes the composer seat for the molecule editor', { skip: !existsSync(bundlePath) && 'run `npm run build` first' }, () => {
  const { registrations } = loadBundle()
  const seat = registrations.find((r) => r.slot === 'conversation.input.left')
  ok(seat !== undefined, 'the benzene button must register into the composer tool row')
  strictEqual(seat.key, 'synomega-ketcher')

  const drafts: string[] = []
  render(createElement(seat.component as never, {
    session: {},
    useInput: (selector: (state: { draft: string, phase: string }) => unknown) => selector({ draft: 'compare', phase: 'plain' }),
    inputActions: { setDraft: (text: string) => { drafts.push(text) } },
  } as never))
  ok(screen.getByLabelText('Draw a molecule'))
  cleanup()
})

test('a view from the built bundle renders a real captured result', { skip: !existsSync(bundlePath) && 'run `npm run build` first' }, () => {
  const { registrations } = loadBundle()
  const view = registrations.find((r) => r.key === 'synomega_retro')
  ok(view !== undefined)
  render(createElement(view.component as never, {
    callId: 'call_00_Kl7B141Hi25dbSNYOItO0735',
    toolName: 'synomega_retro',
    block: { meta: REAL_META },
    openFile: () => {},
  } as never))
  ok(screen.getByText('Retrosynthesis'))
  ok(screen.getByText('0.1364'), 'the top disconnection score should be shown')
  ok(screen.getByText('0.1142'))
  cleanup()
})

function deepEqualKeys(actual: string[], expected: string[]): void {
  strictEqual(actual.join(','), expected.join(','))
}
