/**
 * Reading tool-result metadata written by a possibly-older build.
 *
 * `meta` is `unknown` on the wire, so the contract worth pinning is what happens
 * to input this build does not recognise: it must degrade to null (the generic
 * row) rather than throwing inside a conversation render.
 */

import { strictEqual, deepStrictEqual } from 'node:assert/strict'
import { test } from 'node:test'
import { readCardModel } from '../src/client/meta.ts'

test('unrecognised metadata yields no card rather than a broken one', () => {
  for (const junk of [null, undefined, 42, 'plan', [], { kind: 'from-the-future' }, {}]) {
    strictEqual(readCardModel(junk), null)
  }
})

test('a retro card keeps ranks, reactants and a missing plausibility', () => {
  const model = readCardModel({
    kind: 'retro', target: 'CC(=O)Nc1ccccc1O', shown: 2, total: 7,
    predictions: [
      { rank: 1, reactants: ['CC(=O)O', 'Nc1ccccc1O'], score: 0.43, plausibility: 0.8 },
      { rank: 2, reactants: ['CC(=O)Cl'], score: 0.21, plausibility: null },
    ],
  })
  strictEqual(model?.kind, 'retro')
  if (model?.kind !== 'retro') return
  strictEqual(model.total, 7)
  deepStrictEqual(model.predictions[0]?.reactants, ['CC(=O)O', 'Nc1ccccc1O'])
  strictEqual(model.predictions[1]?.plausibility, null)
})

test('malformed rows are dropped, not turned into blank entries', () => {
  const model = readCardModel({
    kind: 'forward', reactants: ['CCO', 7], shown: 1, total: 1,
    products: ['not a row', { rank: 1, product: 'CCOC', score: 0.5 }],
  })
  strictEqual(model?.kind, 'forward')
  if (model?.kind !== 'forward') return
  deepStrictEqual(model.reactants, ['CCO'])
  strictEqual(model.products.length, 1)
  strictEqual(model.products[0]?.product, 'CCOC')
})

test('a route tree is read with its stock flags intact', () => {
  const model = readCardModel({
    kind: 'plan', target: 'T', solved: true, algorithm: 'retrostar', truncatedNodes: 3,
    routes: [{
      solved: true, num_steps: 1, depth: 1, bb_coverage: 1, cumulative_score: 0.4,
      tree: {
        type: 'mol', smiles: 'T', in_stock: false, depth: 0,
        children: [{
          type: 'reaction', smiles: 'A>>T', score: 0.4,
          children: [{ type: 'mol', smiles: 'A', in_stock: true, depth: 1 }],
        }],
      },
    }],
  })
  strictEqual(model?.kind, 'plan')
  if (model?.kind !== 'plan') return
  strictEqual(model.truncatedNodes, 3)
  const tree = model.routes[0]?.tree
  strictEqual(tree?.smiles, 'T')
  strictEqual(tree?.inStock, false)
  strictEqual(tree?.children?.[0]?.type, 'reaction')
  strictEqual(tree?.children?.[0]?.children?.[0]?.inStock, true)
})

test('a tree node without a usable type is discarded', () => {
  const model = readCardModel({
    kind: 'score', target: 'T', score: 0.5, solved: false,
    bestRoute: { type: 'molecule', smiles: 'T' },
  })
  strictEqual(model?.kind, 'score')
  if (model?.kind !== 'score') return
  strictEqual(model.bestRoute, null)
})

test('an absurdly deep tree is cut instead of blowing the stack', () => {
  let node: Record<string, unknown> = { type: 'mol', smiles: 'LEAF' }
  for (let i = 0; i < 200; i += 1) {
    node = { type: 'mol', smiles: `M${i}`, children: [node] }
  }
  const model = readCardModel({ kind: 'score', target: 'T', bestRoute: node })
  strictEqual(model?.kind, 'score')
  if (model?.kind !== 'score') return
  let depth = 0
  let cursor = model.bestRoute
  while (cursor?.children?.[0] !== undefined) { cursor = cursor.children[0]; depth += 1 }
  strictEqual(depth <= 64, true)
})
