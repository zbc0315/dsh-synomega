/**
 * Single-step prediction: one reaction, in either direction.
 *
 * Retro answers "what reacts to give this?", forward answers "what do these
 * give?". They are separate models in SynOmega and separate tools here, because
 * a model choosing between them is choosing between two different questions.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { asCanonical, field, runOp, text, type ToolDeps } from './shared.ts'

/** One ranked retro candidate, as the canonical value carries it. */
interface RetroPrediction {
  rank: number
  reactants: string[]
  reaction_smiles: string
  score: number
  template_id: number | null
  plausibility: number | null
}

interface ForwardPrediction {
  rank: number
  product: string
  reaction_smiles: string
  score: number
  template_id: number | null
}

export function retroTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'synomega_retro',
    description:
      'Single-step retrosynthesis: given a PRODUCT (SMILES), rank one-step disconnections into ' +
      'candidate reactant sets. Use for "what reacts to give X?" or "how could this bond be formed?". ' +
      'For a full route down to purchasable material use synomega_plan instead.',
    parameters: {
      product: {
        type: 'string', required: true,
        description: 'Product SMILES. Resolve a chemical name to SMILES before calling.',
      },
      top_k: {
        type: 'integer',
        description: 'Candidate disconnections to return, 1-100. Default 10.',
      },
      simplify: {
        type: 'boolean',
        description:
          'Use the simplification-constrained model, which only proposes disconnections that ' +
          'split the target into two or more precursors. Default false.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          target: { type: 'string' },
          elapsed_s: { type: 'number' },
          predictions: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                rank: { type: 'integer' },
                reactants: { type: 'array', items: { type: 'string' } },
                reaction_smiles: { type: 'string', description: 'reactants>>product' },
                score: { type: 'number', description: '0-1, higher is more likely' },
                template_id: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                plausibility: {
                  oneOf: [{ type: 'number' }, { type: 'null' }],
                  description: 'Null unless plausibility screening is enabled in the deployment.',
                },
              },
            },
          },
        },
      },
      render: (args, value) => {
        const predictions = field<RetroPrediction[]>(value, 'predictions', [])
        if (predictions.length === 0) {
          return text(`No disconnection found for ${args.product}.`)
        }
        const lines = predictions.map((p) => {
          const plausibility = p.plausibility === null ? '' : `  plausibility ${p.plausibility.toFixed(2)}`
          return `  ${p.rank}. ${p.reaction_smiles}  score ${p.score.toFixed(4)}${plausibility}`
        })
        return text(
          `${predictions.length} disconnection(s) for ${args.product}, best first:\n${lines.join('\n')}`,
        )
      },
      presentationMeta: (args, value) => {
        if (!deps.config.visualize) return null
        const predictions = field<RetroPrediction[]>(value, 'predictions', [])
        const shown = predictions.slice(0, deps.config.maxCardItems)
        return {
          kind: 'retro',
          target: args.product,
          shown: shown.length,
          total: predictions.length,
          predictions: shown.map((p) => ({
            rank: p.rank,
            reactants: p.reactants,
            score: p.score,
            plausibility: p.plausibility,
          })),
        }
      },
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `retrosynthesis · ${args.product}`,
      kind: 'other',
      rawInput: args,
    }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const value = await runOp(deps, 'retro', {
        product: args.product,
        top_k: args.top_k,
        simplify: args.simplify ?? false,
        plausibility: deps.config.plausibility,
        plausibility_threshold: deps.config.plausibilityThreshold,
        algorithm: deps.config.algorithm,
      }, exec, deps.config.timeouts.retro)
      return asCanonical(value)
    },
  })
}

export function forwardTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'synomega_forward',
    description:
      'Single-step forward reaction prediction: given REACTANTS (dot-separated SMILES), rank the ' +
      'likely products. Use for "what do these reactants give?" or "what is the outcome of this ' +
      'reaction?". Predictions are template-based candidates, not guarantees.',
    parameters: {
      reactants: {
        type: 'string', required: true,
        description: 'Reactant SMILES, dot-separated for multiple molecules, e.g. "CC(=O)O.NCc1ccccc1".',
      },
      top_k: { type: 'integer', description: 'Candidate products to return, 1-50. Default 5.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          reactants: { type: 'string' },
          elapsed_s: { type: 'number' },
          products: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                rank: { type: 'integer' },
                product: { type: 'string' },
                reaction_smiles: { type: 'string' },
                score: { type: 'number', description: '0-1 forward probability' },
                template_id: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
              },
            },
          },
        },
      },
      render: (args, value) => {
        const products = field<ForwardPrediction[]>(value, 'products', [])
        if (products.length === 0) {
          return text(`No product predicted for ${args.reactants}.`)
        }
        const lines = products.map((p) => `  ${p.rank}. ${p.product}  score ${p.score.toFixed(4)}`)
        return text(
          `${products.length} predicted product(s) from ${args.reactants}, best first:\n${lines.join('\n')}`,
        )
      },
      presentationMeta: (args, value) => {
        if (!deps.config.visualize) return null
        const products = field<ForwardPrediction[]>(value, 'products', [])
        const shown = products.slice(0, deps.config.maxCardItems)
        return {
          kind: 'forward',
          reactants: args.reactants.split('.').filter((part) => part.length > 0),
          shown: shown.length,
          total: products.length,
          products: shown.map((p) => ({ rank: p.rank, product: p.product, score: p.score })),
        }
      },
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `forward prediction · ${args.reactants}`,
      kind: 'other',
      rawInput: args,
    }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const value = await runOp(deps, 'forward', {
        reactants: args.reactants,
        top_k: args.top_k,
      }, exec, deps.config.timeouts.forward)
      return asCanonical(value)
    },
  })
}
