/**
 * Shared plumbing for the SynOmega tools.
 *
 * Three rules hold across every tool here, and they are the ones that break
 * things when violated:
 *
 * 1. `output.schema` is the programmatic API. It carries handles and fields, not
 *    prose, so Code Mode callers never parse natural language.
 * 2. `output.render` is model-facing text only. No SVG, no markdown tables built
 *    for a UI, no colour — presentation belongs to the card.
 * 3. `presentationMeta` is bounded. A route tree or an evolution network can be
 *    large, and it is persisted on the session log, so every projection here
 *    truncates explicitly and says that it did.
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.ts'
import type { Bootstrap } from '../bootstrap.ts'
import { SynomegaWorker, WorkerError } from '../worker.ts'

/** Everything a tool needs from the plugin instance. */
export interface ToolDeps {
  readonly worker: SynomegaWorker
  readonly bootstrap: Bootstrap
  readonly config: Config
}

/** A single text block — the only content shape these tools produce. */
export function text(body: string): ContentBlock[] {
  return [{ type: 'text', text: body }]
}

/**
 * Run one worker operation, turning transport and domain failures into messages
 * a model can act on.
 *
 * A call that arrives while provisioning is still running reports the phase
 * rather than failing: "downloading the model" is a wait, not an error, and a
 * model told to retry later behaves far better than one shown a stack trace.
 */
export async function runOp(
  deps: ToolDeps,
  op: string,
  params: Record<string, JsonValue | undefined>,
  exec: ToolRunContext,
  timeoutMs: number,
): Promise<JsonValue> {
  const status = deps.bootstrap.describe()
  if (status.phase === 'installing' || status.phase === 'downloading-assets') {
    throw new Error(
      `SynOmega is still being set up: ${status.detail}. This happens once; ` +
      'retry in a minute rather than falling back to another approach.',
    )
  }
  const cleaned: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) cleaned[key] = value
  }
  try {
    return await deps.worker.call(op, cleaned, exec.signal, timeoutMs)
  } catch (error) {
    throw describeFailure(error)
  }
}

/** Turn a {@link WorkerError} into the most actionable message available. */
function describeFailure(error: unknown): Error {
  if (!(error instanceof WorkerError)) {
    return error instanceof Error ? error : new Error(String(error))
  }
  const detail = error.detail !== undefined && error.detail.length > 0
    ? `\n--- python stderr (tail) ---\n${error.detail}`
    : ''
  return new Error(`${error.message}${detail}`)
}

// --------------------------------------------------------------- projections

/** A molecule node as it appears in SynOmega's serialized route tree. */
export interface RouteTreeNode {
  type: 'mol' | 'reaction'
  smiles: string
  in_stock?: boolean
  depth?: number
  score?: number
  template_id?: number | null
  children?: RouteTreeNode[]
}

/** Outcome of bounding a route tree for display. */
export interface BoundedTree {
  tree: RouteTreeNode | null
  /** Nodes dropped because the cap was reached. */
  truncated: number
}

/**
 * Copy a route tree, stopping at `maxNodes`.
 *
 * Breadth-first, so a truncated tree keeps the shallow structure a reader cares
 * about rather than one deep spine. The dropped count is returned so the card
 * can label the result truncated — a tree that silently loses branches reads as
 * a complete route that it is not.
 */
export function boundTree(root: unknown, maxNodes: number): BoundedTree {
  if (!isTreeNode(root)) return { tree: null, truncated: 0 }
  let budget = Math.max(1, maxNodes)
  let dropped = 0

  const copy = (node: RouteTreeNode): RouteTreeNode => {
    const out: RouteTreeNode = { type: node.type, smiles: node.smiles }
    if (node.in_stock !== undefined) out.in_stock = node.in_stock
    if (node.depth !== undefined) out.depth = node.depth
    if (node.score !== undefined) out.score = node.score
    if (node.template_id !== undefined) out.template_id = node.template_id
    return out
  }

  const rootCopy = copy(root)
  budget -= 1
  const queue: Array<[RouteTreeNode, RouteTreeNode]> = [[root, rootCopy]]
  while (queue.length > 0) {
    const entry = queue.shift()
    if (entry === undefined) break
    const [source, target] = entry
    const children = Array.isArray(source.children) ? source.children : []
    const kept: RouteTreeNode[] = []
    for (const child of children) {
      if (!isTreeNode(child)) continue
      if (budget <= 0) {
        dropped += countNodes(child)
        continue
      }
      budget -= 1
      const childCopy = copy(child)
      kept.push(childCopy)
      queue.push([child, childCopy])
    }
    if (kept.length > 0) target.children = kept
  }
  return { tree: rootCopy, truncated: dropped }
}

function countNodes(node: RouteTreeNode): number {
  const children = Array.isArray(node.children) ? node.children : []
  return 1 + children.reduce((sum, child) => sum + (isTreeNode(child) ? countNodes(child) : 0), 0)
}

function isTreeNode(value: unknown): value is RouteTreeNode {
  if (typeof value !== 'object' || value === null) return false
  const node = value as Record<string, unknown>
  return (node['type'] === 'mol' || node['type'] === 'reaction') && typeof node['smiles'] === 'string'
}

/** Flatten a route tree into its reaction steps, deepest precursors last. */
export function describeRoute(root: unknown, limit = 25): string[] {
  const lines: string[] = []
  const walk = (node: unknown): void => {
    if (!isTreeNode(node) || lines.length >= limit) return
    if (node.type === 'reaction') {
      const score = typeof node.score === 'number' ? ` (score ${node.score.toFixed(4)})` : ''
      lines.push(`${node.smiles}${score}`)
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(root)
  return lines
}

/** Building blocks a route never reached — the reason a target is unsolved. */
export function missingLeaves(root: unknown): string[] {
  const missing: string[] = []
  const walk = (node: unknown): void => {
    if (!isTreeNode(node)) return
    const children = node.children ?? []
    if (node.type === 'mol' && children.length === 0 && node.in_stock === false) {
      missing.push(node.smiles)
    }
    for (const child of children) walk(child)
  }
  walk(root)
  return missing
}

/** Read one property off a canonical value without pretending it is typed. */
export function field<T>(value: JsonValue, key: string, fallback: T): T {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fallback
  const found = (value as Record<string, unknown>)[key]
  return (found === undefined || found === null ? fallback : found) as T
}

/**
 * Adopt a worker reply as this tool's canonical value.
 *
 * The subprocess is a wire boundary, so the value is genuinely unknown here.
 * It is not left unchecked: the tool registry validates every returned value
 * against `output.schema` and converges a mismatch into an error result before
 * anything reaches the model. This helper marks the one place that trust is
 * transferred, instead of scattering casts through the tools.
 */
export function asCanonical<T>(value: JsonValue): T {
  return value as T
}
