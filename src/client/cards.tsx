/**
 * The five SynOmega tool cards.
 *
 * Each is a pure function of one tool call's frozen block: it reads the
 * presentation metadata the host attached to the result and draws it. No card
 * reads session state, fetches anything, or holds state beyond local expansion,
 * which is what makes replaying an old conversation produce the same picture.
 *
 * A call still running, a result without metadata, and a result this build does
 * not recognise all fall back to a plain line rather than an empty card.
 */

import { useState } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { Structure, useTheme, type Theme } from './Structure.tsx'
import { RouteTree } from './RouteTree.tsx'
import { readCardModel, type CardModel } from './meta.ts'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'

/**
 * The composed props a `tool.call.toolview` registration receives. The owner
 * payload is spread across the props rather than nested, so the frozen call
 * block is `props.block`; the rest of the runtime share is untouched here.
 */
export type CardProps = ToolCallViewProps

const MUTED: CSSProperties = { fontSize: 11, opacity: 0.7 }

function Shell(props: { title: string, subtitle?: string, children: ReactNode }): ReactElement {
  return (
    <div style={{ border: '1px solid currentColor', borderRadius: 8, padding: 10, margin: '4px 0', opacity: 0.999 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 6 }}>
        <strong style={{ fontSize: 12 }}>{props.title}</strong>
        {props.subtitle === undefined ? null : <span style={MUTED}>{props.subtitle}</span>}
      </div>
      {props.children}
    </div>
  )
}

/** A 0-1 score as a small bar plus its number; bars compare, numbers report. */
function Score(props: { value: number, label?: string }): ReactElement {
  const width = Math.max(2, Math.min(100, props.value * 100))
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ display: 'inline-block', width: 60, height: 5, background: 'currentColor', opacity: 0.15, borderRadius: 3 }}>
        <span style={{ display: 'block', width: `${width}%`, height: 5, background: 'currentColor', opacity: 0.6, borderRadius: 3 }} />
      </span>
      <span style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
        {props.label ?? props.value.toFixed(4)}
      </span>
    </span>
  )
}

/** One reaction row: reactants, an arrow, the product. */
function ReactionRow(props: { reactants: string[], product: string, theme: Theme }): ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      {props.reactants.map((smiles, index) => (
        <span key={`${smiles}-${index}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {index > 0 ? <span style={{ opacity: 0.5 }}>+</span> : null}
          <Structure smiles={smiles} theme={props.theme} width={120} height={82} />
        </span>
      ))}
      <span style={{ opacity: 0.6, padding: '0 4px' }}>→</span>
      <Structure smiles={props.product} theme={props.theme} width={120} height={82} />
    </div>
  )
}

function Truncation(props: { shown: number, total: number, noun: string }): ReactElement | null {
  if (props.total <= props.shown) return null
  return <p style={{ ...MUTED, margin: '6px 0 0' }}>showing {props.shown} of {props.total} {props.noun}</p>
}

// ------------------------------------------------------------------- cards

function RetroCard({ model, theme }: { model: Extract<CardModel, { kind: 'retro' }>, theme: Theme }): ReactElement {
  return (
    <Shell title="Retrosynthesis" subtitle={`${model.total} disconnection(s)`}>
      {model.predictions.length === 0
        ? <p style={MUTED}>No disconnection was found.</p>
        : model.predictions.map((prediction) => (
          <div key={prediction.rank} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
            <span style={{ ...MUTED, width: 18 }}>{prediction.rank}</span>
            <ReactionRow reactants={prediction.reactants} product={model.target} theme={theme} />
            <Score value={prediction.score} />
            {prediction.plausibility === null
              ? null
              : <span style={MUTED}>plausibility {prediction.plausibility.toFixed(2)}</span>}
          </div>
        ))}
      <Truncation shown={model.shown} total={model.total} noun="disconnections" />
    </Shell>
  )
}

function ForwardCard({ model, theme }: { model: Extract<CardModel, { kind: 'forward' }>, theme: Theme }): ReactElement {
  return (
    <Shell title="Forward prediction" subtitle={`${model.total} product(s)`}>
      {model.products.length === 0
        ? <p style={MUTED}>No product was predicted.</p>
        : model.products.map((product) => (
          <div key={product.rank} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0' }}>
            <span style={{ ...MUTED, width: 18 }}>{product.rank}</span>
            <ReactionRow reactants={model.reactants} product={product.product} theme={theme} />
            <Score value={product.score} />
          </div>
        ))}
      <Truncation shown={model.shown} total={model.total} noun="products" />
    </Shell>
  )
}

function PlanCard({ model, theme }: { model: Extract<CardModel, { kind: 'plan' }>, theme: Theme }): ReactElement {
  const [selected, setSelected] = useState(0)
  const route = model.routes[Math.min(selected, model.routes.length - 1)]
  return (
    <Shell
      title="Route planning"
      subtitle={`${model.solved ? 'solved' : 'not solved'} · ${model.routes.length} route(s) · ${model.algorithm}`}
    >
      {model.routes.length === 0 || route === undefined ? (
        <p style={MUTED}>No route was extracted.</p>
      ) : (
        <>
          {model.routes.length > 1 ? (
            <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
              {model.routes.map((candidate, index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => setSelected(index)}
                  style={{
                    fontSize: 11, padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
                    border: '1px solid currentColor',
                    opacity: index === selected ? 1 : 0.55,
                    background: 'transparent', color: 'inherit',
                  }}
                >
                  route {index + 1} · {candidate.numSteps} step(s)
                </button>
              ))}
            </div>
          ) : null}
          <p style={{ ...MUTED, margin: '0 0 6px' }}>
            {route.numSteps} step(s), depth {route.depth},
            {' '}{Math.round(route.bbCoverage * 100)}% of starting materials purchasable
          </p>
          <RouteTree root={route.tree} theme={theme} truncatedNodes={model.truncatedNodes} />
        </>
      )}
    </Shell>
  )
}

function ScoreCard({ model, theme }: { model: Extract<CardModel, { kind: 'score' }>, theme: Theme }): ReactElement {
  const missing = model.numLeaves - model.numPurchasableLeaves
  return (
    <Shell title="Synthesizability" subtitle={model.solved ? 'solved' : 'unsolved'}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 6 }}>
        <span style={{ fontSize: 26, fontVariantNumeric: 'tabular-nums' }}>{model.score.toFixed(3)}</span>
        <div>
          <div style={{ fontSize: 11 }}>SynScore</div>
          <div style={MUTED}>
            {missing} of {model.numLeaves} starting material(s) not purchasable ·
            {' '}shortest route {model.minSteps} step(s)
          </div>
        </div>
        <Structure smiles={model.target} theme={theme} width={140} height={90} />
      </div>
      <RouteTree root={model.bestRoute} theme={theme} truncatedNodes={model.truncatedNodes} />
    </Shell>
  )
}

function EvolveCard({ model, theme }: { model: Extract<CardModel, { kind: 'evolve' }>, theme: Theme }): ReactElement {
  const depths = [...new Set(model.molecules.map((molecule) => molecule.depth))].sort((a, b) => a - b)
  return (
    <Shell
      title="Multi-component evolution"
      subtitle={`${model.numMolecules} molecule(s) · ${model.numReactionEdges} reaction edge(s)`}
    >
      {model.molecules.length === 0 ? (
        <p style={MUTED}>Nothing above the score threshold.</p>
      ) : (
        <div style={{ display: 'flex', gap: 12, overflowX: 'auto' }}>
          {depths.map((depth) => (
            <div key={depth} style={{ minWidth: 150 }}>
              <div style={{ ...MUTED, marginBottom: 4 }}>depth {depth}</div>
              {model.molecules.filter((molecule) => molecule.depth === depth).map((molecule) => (
                <div
                  key={molecule.smiles}
                  title={molecule.parents === null ? 'starting reactant' : `from ${molecule.parents.join(' + ')}`}
                  style={{ border: '1px solid currentColor', borderRadius: 6, padding: 4, marginBottom: 6 }}
                >
                  <Structure smiles={molecule.smiles} theme={theme} width={136} height={84} />
                  <Score value={molecule.totalScore} />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <Truncation shown={model.shown} total={model.total} noun="molecules" />
    </Shell>
  )
}

/**
 * The registered view for every SynOmega tool.
 *
 * One component for all five keys: the metadata is self-describing, so keying on
 * its `kind` keeps the dispatch in one place instead of five near-identical
 * wrappers.
 */
export function SynomegaToolView(props: CardProps): ReactElement | null {
  const theme = useTheme()
  // `meta` exists only on a settled result; a running call has no block.meta,
  // which is exactly the null path below.
  const model = readCardModel((props.block as { meta?: unknown }).meta)

  if (model === null) {
    // Running calls, errors, and results from a build whose card this one does
    // not know all land here. Returning null hands the row back to the generic
    // renderer rather than showing an empty SynOmega card.
    return null
  }

  // Rendered as elements, not called as functions: each card owns its own hook
  // scope, so a card that holds state (route selection) cannot corrupt the hook
  // order of the view that dispatches to it.
  switch (model.kind) {
    case 'retro': return <RetroCard model={model} theme={theme} />
    case 'forward': return <ForwardCard model={model} theme={theme} />
    case 'plan': return <PlanCard model={model} theme={theme} />
    case 'score': return <ScoreCard model={model} theme={theme} />
    case 'evolve': return <EvolveCard model={model} theme={theme} />
  }
}
