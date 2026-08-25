/**
 * Parse the presentation metadata a SynOmega tool attached to its result.
 *
 * `ToolResultNode.meta` is `unknown`: it crosses a process boundary and comes
 * out of a session log that may have been written by an older version of this
 * plugin. Everything here therefore validates rather than casts, and returns
 * `null` on anything it does not recognise — an unrecognised card falls back to
 * the generic tool row, which is a worse view but never a broken one.
 */

/** One molecule node inside a route tree. */
export interface TreeNode {
  type: 'mol' | 'reaction'
  smiles: string
  inStock?: boolean
  depth?: number
  score?: number
  children?: TreeNode[]
}

export interface RetroCardModel {
  kind: 'retro'
  target: string
  shown: number
  total: number
  predictions: Array<{
    rank: number
    reactants: string[]
    score: number
    plausibility: number | null
  }>
}

export interface ForwardCardModel {
  kind: 'forward'
  reactants: string[]
  shown: number
  total: number
  products: Array<{ rank: number, product: string, score: number }>
}

export interface PlanCardModel {
  kind: 'plan'
  target: string
  solved: boolean
  algorithm: string
  truncatedNodes: number
  routes: Array<{
    solved: boolean
    numSteps: number
    depth: number
    bbCoverage: number
    cumulativeScore: number
    tree: TreeNode | null
  }>
}

export interface ScoreCardModel {
  kind: 'score'
  target: string
  score: number
  solved: boolean
  bbCoverage: number
  minSteps: number
  numLeaves: number
  numPurchasableLeaves: number
  bestRoute: TreeNode | null
  truncatedNodes: number
}

export interface EvolveCardModel {
  kind: 'evolve'
  reactants: string[]
  numMolecules: number
  numReactionEdges: number
  shown: number
  total: number
  molecules: Array<{
    smiles: string
    totalScore: number
    depth: number
    parents: string[] | null
  }>
}

export type CardModel =
  | RetroCardModel | ForwardCardModel | PlanCardModel | ScoreCardModel | EvolveCardModel

// ------------------------------------------------------------------ readers

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function str(source: Record<string, unknown>, key: string, fallback = ''): string {
  const value = source[key]
  return typeof value === 'string' ? value : fallback
}

function num(source: Record<string, unknown>, key: string, fallback = 0): number {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bool(source: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = source[key]
  return typeof value === 'boolean' ? value : fallback
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.map(record).filter((row): row is Record<string, unknown> => row !== null)
}

/**
 * Read a route tree, bounded by depth.
 *
 * The host already caps node count, but the depth bound here is independent
 * protection: a malformed or hostile log entry must not be able to blow the
 * render stack.
 */
function tree(value: unknown, depth = 0): TreeNode | null {
  if (depth > 64) return null
  const source = record(value)
  if (source === null) return null
  const type = source['type']
  if (type !== 'mol' && type !== 'reaction') return null
  const smiles = source['smiles']
  if (typeof smiles !== 'string') return null

  const node: TreeNode = { type, smiles }
  if (typeof source['in_stock'] === 'boolean') node.inStock = source['in_stock']
  if (typeof source['depth'] === 'number') node.depth = source['depth']
  if (typeof source['score'] === 'number') node.score = source['score']
  const children = Array.isArray(source['children'])
    ? source['children'].map((child) => tree(child, depth + 1)).filter((child): child is TreeNode => child !== null)
    : []
  if (children.length > 0) node.children = children
  return node
}

/**
 * Turn a tool result's `meta` into a card model.
 * @param meta - the `ToolResultNode.meta` value, of unknown provenance.
 * @returns the model, or null when this result carries no card this build knows.
 */
export function readCardModel(meta: unknown): CardModel | null {
  const source = record(meta)
  if (source === null) return null
  switch (source['kind']) {
    case 'retro':
      return {
        kind: 'retro',
        target: str(source, 'target'),
        shown: num(source, 'shown'),
        total: num(source, 'total'),
        predictions: rows(source['predictions']).map((row) => ({
          rank: num(row, 'rank'),
          reactants: strings(row['reactants']),
          score: num(row, 'score'),
          plausibility: typeof row['plausibility'] === 'number' ? row['plausibility'] : null,
        })),
      }
    case 'forward':
      return {
        kind: 'forward',
        reactants: strings(source['reactants']),
        shown: num(source, 'shown'),
        total: num(source, 'total'),
        products: rows(source['products']).map((row) => ({
          rank: num(row, 'rank'),
          product: str(row, 'product'),
          score: num(row, 'score'),
        })),
      }
    case 'plan':
      return {
        kind: 'plan',
        target: str(source, 'target'),
        solved: bool(source, 'solved'),
        algorithm: str(source, 'algorithm'),
        truncatedNodes: num(source, 'truncatedNodes'),
        routes: rows(source['routes']).map((row) => ({
          solved: bool(row, 'solved'),
          numSteps: num(row, 'num_steps'),
          depth: num(row, 'depth'),
          bbCoverage: num(row, 'bb_coverage'),
          cumulativeScore: num(row, 'cumulative_score'),
          tree: tree(row['tree']),
        })),
      }
    case 'score':
      return {
        kind: 'score',
        target: str(source, 'target'),
        score: num(source, 'score'),
        solved: bool(source, 'solved'),
        bbCoverage: num(source, 'bbCoverage'),
        minSteps: num(source, 'minSteps'),
        numLeaves: num(source, 'numLeaves'),
        numPurchasableLeaves: num(source, 'numPurchasableLeaves'),
        bestRoute: tree(source['bestRoute']),
        truncatedNodes: num(source, 'truncatedNodes'),
      }
    case 'evolve':
      return {
        kind: 'evolve',
        reactants: strings(source['reactants']),
        numMolecules: num(source, 'numMolecules'),
        numReactionEdges: num(source, 'numReactionEdges'),
        shown: num(source, 'shown'),
        total: num(source, 'total'),
        molecules: rows(source['molecules']).map((row) => ({
          smiles: str(row, 'smiles'),
          totalScore: num(row, 'totalScore'),
          depth: num(row, 'depth'),
          parents: Array.isArray(row['parents']) ? strings(row['parents']) : null,
        })),
      }
    default:
      return null
  }
}
