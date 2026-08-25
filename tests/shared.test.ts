/**
 * Projection helpers: the bounded, replayable JSON the cards consume.
 *
 * These run against literal trees rather than live SynOmega output on purpose —
 * the point is to pin the truncation contract (a card must never present a
 * clipped route as a complete one), which is exactly what a live test would be
 * least able to reproduce on demand.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict'
import { test } from 'node:test'
import { boundTree, describeRoute, missingLeaves } from '../src/tools/shared.ts'
import { sameExtras, venvPython } from '../src/bootstrap.ts'

/** A two-step route: target <- (A + B), B <- (C). C and A are purchasable. */
const route = {
  type: 'mol', smiles: 'TARGET', in_stock: false, depth: 0,
  children: [{
    type: 'reaction', smiles: 'A.B>>TARGET', score: 0.43, template_id: 12,
    children: [
      { type: 'mol', smiles: 'A', in_stock: true, depth: 1 },
      {
        type: 'mol', smiles: 'B', in_stock: false, depth: 1,
        children: [{
          type: 'reaction', smiles: 'C>>B', score: 0.22, template_id: 34,
          children: [{ type: 'mol', smiles: 'C', in_stock: true, depth: 2 }],
        }],
      },
    ],
  }],
}

test('boundTree copies a small tree whole and reports no truncation', () => {
  const bounded = boundTree(route, 100)
  strictEqual(bounded.truncated, 0)
  strictEqual(bounded.tree?.smiles, 'TARGET')
  strictEqual(bounded.tree?.children?.[0]?.children?.length, 2)
})

test('boundTree drops breadth-first and counts every dropped node', () => {
  const bounded = boundTree(route, 3)
  // root + reaction + A leaves nothing for B's subtree (B, its reaction, C).
  strictEqual(bounded.truncated, 3)
  strictEqual(bounded.tree?.children?.[0]?.children?.length, 1)
  strictEqual(bounded.tree?.children?.[0]?.children?.[0]?.smiles, 'A')
})

test('boundTree keeps the root even when the cap is absurdly small', () => {
  const bounded = boundTree(route, 0)
  strictEqual(bounded.tree?.smiles, 'TARGET')
  // The six-node tree keeps only its root; the other five are reported dropped.
  strictEqual(bounded.truncated, 5)
  strictEqual(bounded.tree?.children, undefined)
})

test('boundTree rejects a non-tree instead of inventing one', () => {
  deepStrictEqual(boundTree(null, 10), { tree: null, truncated: 0 })
  deepStrictEqual(boundTree({ nope: true }, 10), { tree: null, truncated: 0 })
})

test('describeRoute lists reactions in route order', () => {
  deepStrictEqual(describeRoute(route), [
    'A.B>>TARGET (score 0.4300)',
    'C>>B (score 0.2200)',
  ])
})

test('missingLeaves reports only unpurchasable leaves, not internal nodes', () => {
  // B is unpurchasable but has a reaction, so it is not a starting material.
  deepStrictEqual(missingLeaves(route), [])
  const partial = {
    type: 'mol', smiles: 'TARGET', in_stock: false, depth: 0,
    children: [{
      type: 'reaction', smiles: 'X.Y>>TARGET', score: 0.5,
      children: [
        { type: 'mol', smiles: 'X', in_stock: false, depth: 1 },
        { type: 'mol', smiles: 'Y', in_stock: true, depth: 1 },
      ],
    }],
  }
  deepStrictEqual(missingLeaves(partial), ['X'])
})

test('sameExtras compares as sets, not as lists', () => {
  strictEqual(sameExtras(['gnn', 'viz'], ['viz', 'gnn']), true)
  strictEqual(sameExtras(['gnn', 'gnn'], ['gnn']), true)
  strictEqual(sameExtras([], ['gnn']), false)
  strictEqual(sameExtras(['gnn'], ['viz']), false)
})

test('venvPython follows the platform layout', () => {
  const path = venvPython('/tmp/venv')
  strictEqual(path.includes('python'), true)
  strictEqual(path.startsWith('/tmp/venv'), true)
})
