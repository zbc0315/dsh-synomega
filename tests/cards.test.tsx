/**
 * The tool cards, rendered into jsdom.
 *
 * jsdom cannot lay out SVG, so SmilesDrawer fails and every depiction falls back
 * to its SMILES text — which is the fallback the cards must have anyway, and it
 * makes the structural assertions here readable. What is being pinned is the
 * behaviour a chemist would notice if it broke: truncation stays visible,
 * purchasable and unpurchasable leaves stay distinguishable, and a result with
 * no card data hands the row back instead of drawing an empty box.
 */

import 'global-jsdom/register'
import { strictEqual, ok } from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { cleanup, render, screen } from '@testing-library/react'
import { SynomegaToolView } from '../src/client/cards.tsx'
import { collapseRoute } from '../src/client/RouteTree.tsx'
import { clearDepictionCache } from '../src/client/Structure.tsx'

afterEach(() => { cleanup(); clearDepictionCache() })

/** Minimal owner props: the cards read only the frozen block. */
function view(meta: unknown): any {
  return { callId: 'c1', toolName: 'synomega_plan', block: { meta }, openFile: () => {} }
}

const routeTree = {
  type: 'mol', smiles: 'CC(=O)Nc1ccccc1O', in_stock: false, depth: 0,
  children: [{
    type: 'reaction', smiles: 'CC(=O)O.Nc1ccccc1O>>CC(=O)Nc1ccccc1O', score: 0.43,
    children: [
      { type: 'mol', smiles: 'CC(=O)O', in_stock: true, depth: 1 },
      { type: 'mol', smiles: 'Nc1ccccc1O', in_stock: false, depth: 1 },
    ],
  }],
}

test('a running call, or one with no card data, renders nothing', () => {
  const { container } = render(<SynomegaToolView {...view(undefined)} />)
  strictEqual(container.textContent, '')
})

test('the retro card shows each disconnection with its score', () => {
  render(<SynomegaToolView {...view({
    kind: 'retro', target: 'CC(=O)Nc1ccccc1O', shown: 2, total: 9,
    predictions: [
      { rank: 1, reactants: ['CC(=O)O', 'Nc1ccccc1O'], score: 0.4321, plausibility: 0.81 },
      { rank: 2, reactants: ['CC(=O)Cl', 'Nc1ccccc1O'], score: 0.2109, plausibility: null },
    ],
  })} />)
  ok(screen.getByText('Retrosynthesis'))
  ok(screen.getByText('0.4321'))
  ok(screen.getByText('0.2109'))
  ok(screen.getByText('plausibility 0.81'))
})

test('a partial view says so instead of implying it is complete', () => {
  render(<SynomegaToolView {...view({
    kind: 'retro', target: 'CCO', shown: 2, total: 9,
    predictions: [
      { rank: 1, reactants: ['CC'], score: 0.4, plausibility: null },
      { rank: 2, reactants: ['CO'], score: 0.3, plausibility: null },
    ],
  })} />)
  ok(screen.getByText('showing 2 of 9 disconnections'))
})

test('the plan card reports solved state, route count and a truncated tree', () => {
  render(<SynomegaToolView {...view({
    kind: 'plan', target: 'CC(=O)Nc1ccccc1O', solved: true, algorithm: 'retrostar',
    truncatedNodes: 5,
    routes: [{
      solved: true, num_steps: 2, depth: 2, bb_coverage: 0.5,
      cumulative_score: 0.09, tree: routeTree,
    }],
  })} />)
  ok(screen.getByText('Route planning'))
  ok(screen.getByText(/solved · 1 route\(s\) · retrostar/))
  ok(screen.getByText(/2 step\(s\), depth 2/))
  ok(screen.getByText('5 further node(s) not shown — this view is truncated.'))
})

test('the plan card marks purchasable and unpurchasable starting materials apart', () => {
  render(<SynomegaToolView {...view({
    kind: 'plan', target: 'T', solved: false, algorithm: 'retrostar', truncatedNodes: 0,
    routes: [{ solved: false, num_steps: 1, depth: 1, bb_coverage: 0.5, cumulative_score: 0.4, tree: routeTree }],
  })} />)
  ok(screen.getByText('purchasable'))
  ok(screen.getByText('not purchasable'))
})

test('multiple routes are selectable', () => {
  render(<SynomegaToolView {...view({
    kind: 'plan', target: 'T', solved: true, algorithm: 'bfs', truncatedNodes: 0,
    routes: [
      { solved: true, num_steps: 2, depth: 2, bb_coverage: 1, cumulative_score: 0.2, tree: routeTree },
      { solved: true, num_steps: 4, depth: 3, bb_coverage: 1, cumulative_score: 0.1, tree: routeTree },
    ],
  })} />)
  ok(screen.getByText('route 1 · 2 step(s)'))
  ok(screen.getByText('route 2 · 4 step(s)'))
})

test('the score card leads with SynScore and how many materials are missing', () => {
  render(<SynomegaToolView {...view({
    kind: 'score', target: 'CC(=O)Nc1ccccc1O', score: 0.5, solved: false,
    bbCoverage: 0.5, minSteps: 2, numLeaves: 2, numPurchasableLeaves: 1,
    bestRoute: routeTree, truncatedNodes: 0,
  })} />)
  ok(screen.getByText('0.500'))
  ok(screen.getByText('SynScore'))
  ok(screen.getByText(/1 of 2 starting material\(s\) not purchasable/))
  ok(screen.getByText('unsolved'))
})

test('the evolution card groups molecules by depth', () => {
  render(<SynomegaToolView {...view({
    kind: 'evolve', reactants: ['CC(=O)c1ccccc1', 'C=O'],
    numMolecules: 12, numReactionEdges: 8, shown: 3, total: 12,
    molecules: [
      { smiles: 'CC(=O)c1ccccc1', totalScore: 1, depth: 0, parents: null },
      { smiles: 'C=O', totalScore: 1, depth: 0, parents: null },
      { smiles: 'OCC(=O)c1ccccc1', totalScore: 0.4, depth: 1, parents: ['CC(=O)c1ccccc1', 'C=O'] },
    ],
  })} />)
  ok(screen.getByText('depth 0'))
  ok(screen.getByText('depth 1'))
  ok(screen.getByText('12 molecule(s) · 8 reaction edge(s)'))
  ok(screen.getByText('showing 3 of 12 molecules'))
})

test('an empty result says nothing was found rather than showing a blank card', () => {
  render(<SynomegaToolView {...view({
    kind: 'forward', reactants: ['CCO'], shown: 0, total: 0, products: [],
  })} />)
  ok(screen.getByText('No product was predicted.'))
})

test('collapseRoute folds reactions onto the edges', () => {
  const collapsed = collapseRoute({
    type: 'mol', smiles: 'T', inStock: false,
    children: [{
      type: 'reaction', smiles: 'A.B>>T', score: 0.43,
      children: [
        { type: 'mol', smiles: 'A', inStock: true },
        { type: 'mol', smiles: 'B', inStock: false },
      ],
    }],
  })
  strictEqual(collapsed?.smiles, 'T')
  strictEqual(collapsed?.edgeScore, null)
  strictEqual(collapsed?.precursors.length, 2)
  strictEqual(collapsed?.precursors[0]?.smiles, 'A')
  // The reaction's score rides on the edge into each precursor.
  strictEqual(collapsed?.precursors[0]?.edgeScore, 0.43)
  strictEqual(collapsed?.precursors[0]?.inStock, true)
  strictEqual(collapsed?.precursors[1]?.inStock, false)
})

test('collapseRoute refuses a reaction node as a root', () => {
  strictEqual(collapseRoute({ type: 'reaction', smiles: 'A>>B' }), null)
  strictEqual(collapseRoute(null), null)
})
