/**
 * A synthesis route drawn as a tree.
 *
 * SynOmega serialises a route as alternating molecule and reaction nodes. Here
 * the reaction nodes are collapsed onto the edges: a chemist reads a route as
 * "this molecule comes from those precursors, by a reaction with this score",
 * so the reaction belongs on the arrow, not in a box of its own.
 *
 * Layout comes from d3-hierarchy; the drawing is plain SVG for the edges plus
 * positioned elements for the molecules, so each node can reuse the same
 * depiction component (and its cache) as every other card.
 */

import { hierarchy, tree as d3tree } from 'd3-hierarchy'
import type { ReactElement } from 'react'
import { Structure, type Theme } from './Structure.tsx'
import type { TreeNode } from './meta.ts'

/** One molecule in the laid-out tree, with the reaction that produced it. */
interface RouteMolecule {
  smiles: string
  inStock: boolean
  /** Score of the reaction that makes this molecule's parent, when there is one. */
  edgeScore: number | null
  precursors: RouteMolecule[]
}

const NODE_WIDTH = 150
const NODE_HEIGHT = 104
const H_GAP = 26
const V_GAP = 62

/**
 * Collapse the mol/reaction alternation into molecules linked by scored edges.
 * @param node - a molecule node from the serialized route.
 * @param edgeScore - score of the reaction that produced this molecule.
 * @returns the molecule and its precursors, or null when the node is not a molecule.
 */
export function collapseRoute(node: TreeNode | null, edgeScore: number | null = null): RouteMolecule | null {
  if (node === null || node.type !== 'mol') return null
  // A molecule has at most one reaction child; that reaction's children are the
  // precursors. A molecule with no reaction is a leaf: purchasable, or a dead end.
  const reaction = (node.children ?? []).find((child) => child.type === 'reaction')
  const precursors = (reaction?.children ?? [])
    .map((child) => collapseRoute(child, reaction?.score ?? null))
    .filter((child): child is RouteMolecule => child !== null)
  return {
    smiles: node.smiles,
    inStock: node.inStock === true,
    edgeScore,
    precursors,
  }
}

export interface RouteTreeProps {
  root: TreeNode | null
  theme: Theme
  /** Nodes the host dropped when bounding the tree; shown so a clipped route is never read as whole. */
  truncatedNodes?: number
}

export function RouteTree(props: RouteTreeProps): ReactElement | null {
  const collapsed = collapseRoute(props.root)
  if (collapsed === null) return null

  // The layout call is what turns x/y from optional into known, so the laid-out
  // node is what everything below reads — not the input hierarchy.
  const laid = d3tree<RouteMolecule>()
    .nodeSize([NODE_WIDTH + H_GAP, NODE_HEIGHT + V_GAP])(
      hierarchy<RouteMolecule>(collapsed, (molecule) => molecule.precursors),
    )

  const nodes = laid.descendants()
  const xs = nodes.map((node) => node.x)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const maxY = Math.max(...nodes.map((node) => node.y))
  const width = maxX - minX + NODE_WIDTH + H_GAP
  const height = maxY + NODE_HEIGHT + 28
  const shift = (x: number): number => x - minX + H_GAP / 2

  return (
    <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
      <div style={{ position: 'relative', width, height, minWidth: '100%' }}>
        <svg
          width={width} height={height} aria-hidden="true"
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
        >
          {laid.links().map((link) => {
            const x1 = shift(link.source.x) + NODE_WIDTH / 2
            const y1 = link.source.y + NODE_HEIGHT
            const x2 = shift(link.target.x) + NODE_WIDTH / 2
            const y2 = link.target.y
            const midY = (y1 + y2) / 2
            const score = link.target.data.edgeScore
            return (
              <g key={`${link.source.data.smiles}->${link.target.data.smiles}`}>
                <path
                  d={`M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`}
                  fill="none" stroke="currentColor" strokeOpacity={0.35} strokeWidth={1.5}
                />
                {score === null ? null : (
                  <text
                    x={(x1 + x2) / 2} y={midY} textAnchor="middle"
                    fontSize={10} fill="currentColor" fillOpacity={0.6}
                  >
                    {score.toFixed(3)}
                  </text>
                )}
              </g>
            )
          })}
        </svg>

        {nodes.map((node) => {
          const leaf = node.data.precursors.length === 0
          // Colour says one thing only: can this starting material be bought?
          // Internal nodes are neutral, because the question does not apply.
          const border = !leaf
            ? 'currentColor'
            : node.data.inStock ? '#2e9e5b' : '#c0392b'
          return (
            <div
              key={`${node.data.smiles}@${node.depth}-${node.x}`}
              style={{
                position: 'absolute', left: shift(node.x), top: node.y,
                width: NODE_WIDTH, height: NODE_HEIGHT,
                border: `1px solid ${border}`,
                borderRadius: 6,
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', background: 'transparent',
              }}
            >
              <Structure smiles={node.data.smiles} theme={props.theme} width={NODE_WIDTH - 10} height={NODE_HEIGHT - 22} />
              <span style={{ fontSize: 9, opacity: 0.7 }}>
                {leaf ? (node.data.inStock ? 'purchasable' : 'not purchasable') : ''}
              </span>
            </div>
          )
        })}
      </div>
      {props.truncatedNodes !== undefined && props.truncatedNodes > 0 ? (
        <p style={{ fontSize: 11, opacity: 0.7, margin: '4px 0 0' }}>
          {props.truncatedNodes} further node(s) not shown — this view is truncated.
        </p>
      ) : null}
    </div>
  )
}
