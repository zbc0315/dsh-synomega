/**
 * Multi-component evolution: grow a forward synthesis network from a pool.
 *
 * Repeatedly pick two molecules from a growing pool, run the forward model, add
 * the products back. The result is a network rather than a tree — a molecule can
 * be reached by more than one pair — so it is reported as a molecule list with
 * parent links, not as a route.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { asCanonical, field, runOp, text, type ToolDeps } from './shared.ts'

interface EvolvedMolecule {
  smiles: string
  total_score: number
  depth: number
  step_score: number | null
  parents: [string, string] | null
  template_id: number | null
}

export function evolveTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'synomega_evolve',
    description:
      'Multi-component evolution: from a set of REACTANTS (dot-separated SMILES, at least two), ' +
      'repeatedly react pairs with the forward model and grow a synthesis network. Use for ' +
      'one-pot / multicomponent chemistry, or "what can this mixture form?". Not a route planner: ' +
      'for a route to a known target use synomega_plan.',
    parameters: {
      reactants: {
        type: 'string', required: true,
        description: 'At least two dot-separated reactant SMILES, e.g. "CC(=O)c1ccccc1.C=O.CNC".',
      },
      max_depth: {
        type: 'integer',
        description: 'Rounds of pairing, 1-8. Default 3. Each round multiplies the pool, so raise it slowly.',
      },
      score_threshold: {
        type: 'number',
        description: 'Drop products whose cumulative score falls below this, 0-1. Default 0.01.',
      },
      top: { type: 'integer', description: 'Molecules to report, best first, 1-500. Default 20.' },
      forward_top_k: { type: 'integer', description: 'Products kept per reactant pair, 1-25. Default 5.' },
      frontier_width: {
        type: 'integer',
        description: 'Cap the fan-out per round. Useful when the starting pool is large.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          reactants: { type: 'array', items: { type: 'string' } },
          stats: { type: 'json', description: 'rounds, num_reactions and other run facts' },
          num_molecules: { type: 'integer', description: 'Distinct molecules in the whole network.' },
          num_reaction_edges: { type: 'integer' },
          molecules: {
            type: 'array',
            description: 'Best first, capped by `top`.',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                smiles: { type: 'string' },
                total_score: {
                  type: 'number',
                  description: 'min(parent totals) x step probability; starting reactants are 1.0.',
                },
                depth: { type: 'integer', description: 'Synthesis-tree depth from the starting pool.' },
                step_score: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                parents: {
                  oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }],
                  description: 'The two molecules that reacted; null for a starting reactant.',
                },
                template_id: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
              },
            },
          },
        },
      },
      render: (args, value) => {
        const molecules = field<EvolvedMolecule[]>(value, 'molecules', [])
        const total = field<number>(value, 'num_molecules', molecules.length)
        const edges = field<number>(value, 'num_reaction_edges', 0)
        const header =
          `evolved ${args.reactants} — ${total} distinct molecule(s), ${edges} reaction edge(s)` +
          (molecules.length < total ? `; showing the top ${molecules.length}` : '')
        if (molecules.length === 0) return text(`${header}\nNothing above the score threshold.`)
        const lines = molecules.map((molecule) => {
          const origin = molecule.parents === null
            ? 'starting reactant'
            : `${molecule.parents.join(' + ')}`
          return `  ${molecule.smiles}  score ${molecule.total_score.toFixed(4)}  depth ${molecule.depth}  <- ${origin}`
        })
        return text(`${header}\n${lines.join('\n')}`)
      },
      presentationMeta: (args, value) => {
        if (!deps.config.visualize) return null
        const molecules = field<EvolvedMolecule[]>(value, 'molecules', [])
        // The card lays molecules out by depth, so the cap applies to what is
        // drawn; the canonical value keeps whatever `top` asked for.
        const shown = molecules.slice(0, Math.max(deps.config.maxCardItems, 24))
        return {
          kind: 'evolve',
          reactants: field<string[]>(value, 'reactants', []),
          numMolecules: field<number>(value, 'num_molecules', molecules.length),
          numReactionEdges: field<number>(value, 'num_reaction_edges', 0),
          shown: shown.length,
          total: molecules.length,
          molecules: shown.map((molecule) => ({
            smiles: molecule.smiles,
            totalScore: molecule.total_score,
            depth: molecule.depth,
            parents: molecule.parents,
          })),
        }
      },
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `evolution · ${args.reactants}`,
      kind: 'other',
      rawInput: args,
    }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const value = await runOp(deps, 'evolve', {
        reactants: args.reactants,
        max_depth: args.max_depth,
        score_threshold: args.score_threshold,
        top: args.top,
        forward_top_k: args.forward_top_k,
        frontier_width: args.frontier_width,
      }, exec, deps.config.timeouts.evolve)
      return asCanonical(value)
    },
  })
}
