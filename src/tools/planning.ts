/**
 * Multi-step search: the full route, and the score derived from it.
 *
 * `synomega_plan` and `synomega_score` run the same AND-OR graph search. Plan
 * returns the routes; score folds one search into a single 0-1 number for
 * ranking. They stay separate tools because "show me how to make it" and "rank
 * these 200 candidates by how makeable they are" are different requests, and a
 * combined tool would force every caller to pay for the other one's output.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  asCanonical, boundTree, describeRoute, field, missingLeaves, runOp, text, type ToolDeps,
} from './shared.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

interface RouteRecord {
  solved: boolean
  num_steps: number
  depth: number
  bb_coverage: number
  cumulative_score: number
  tree: JsonValue
}

export function planTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'synomega_plan',
    description:
      'Multi-step retrosynthetic route planning: search from a TARGET (SMILES) down to purchasable ' +
      'building blocks. Use for "how do I make X?" or "give me a synthetic route". Returns whole ' +
      'routes as nested reactions; `solved` says whether every starting material is purchasable.',
    parameters: {
      target: { type: 'string', required: true, description: 'Target product SMILES.' },
      max_depth: { type: 'integer', description: 'Longest route allowed, 1-12. Default 5.' },
      max_routes: { type: 'integer', description: 'Routes to return, best first, 1-25. Default 3.' },
      exclude_target: {
        type: 'boolean',
        description:
          'Treat the target as NOT purchasable even if it is a catalogue item, forcing a real ' +
          'disconnection. Use it when asked how a possibly-buyable molecule would actually be made.',
      },
      simplify: {
        type: 'boolean',
        description:
          'Search with the simplification-constrained model: fewer expansions to reach stock, at ' +
          'matched solvability. Default follows the deployment configuration.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          target: { type: 'string' },
          algorithm: { type: 'string' },
          solved: { type: 'boolean', description: 'A route whose leaves are all purchasable exists.' },
          num_routes_found: { type: 'integer' },
          stats: { type: 'json', description: 'expansions, model_calls, elapsed_s, terminated_by' },
          routes: {
            type: 'array',
            description:
              'Best first. Each route is { solved, num_steps, depth, bb_coverage, cumulative_score, ' +
              'tree }, where `tree` alternates mol and reaction nodes: a mol node carries ' +
              '{ smiles, in_stock, depth } and its single reaction child carries ' +
              '{ smiles (reactants>>product), score, template_id } plus its reactant mol nodes.',
            items: { type: 'json' },
          },
        },
      },
      render: (args, value) => {
        const routes = field<RouteRecord[]>(value, 'routes', [])
        const solved = field<boolean>(value, 'solved', false)
        const stats = field<Record<string, unknown>>(value, 'stats', {})
        const header =
          `target ${args.target} — ${solved ? 'solved' : 'NOT solved'}, ` +
          `${field<number>(value, 'num_routes_found', routes.length)} route(s) found ` +
          `(${String(stats['expansions'] ?? '?')} expansions, stopped by ${String(stats['terminated_by'] ?? '?')})`
        if (routes.length === 0) {
          return text(
            `${header}\nNo route was extracted. Try a larger max_depth, or exclude_target if the ` +
            'target is itself a catalogue item.',
          )
        }
        const blocks = routes.map((route, index) => {
          const steps = describeRoute(route.tree).map((line, i) => `  [${i + 1}] ${line}`)
          const missing = missingLeaves(route.tree)
          const tail = missing.length > 0 ? `\n  not purchasable: ${missing.join(', ')}` : ''
          return (
            `route ${index + 1} (${route.num_steps} step(s), ` +
            `${(route.bb_coverage * 100).toFixed(0)}% of leaves purchasable):\n` +
            `${steps.join('\n')}${tail}`
          )
        })
        return text(`${header}\n${blocks.join('\n')}`)
      },
      presentationMeta: (args, value) => {
        if (!deps.config.visualize) return null
        const routes = field<RouteRecord[]>(value, 'routes', [])
        let truncated = 0
        const projected = routes.map((route) => {
          const bounded = boundTree(route.tree, deps.config.maxTreeNodes)
          truncated += bounded.truncated
          return {
            solved: route.solved,
            num_steps: route.num_steps,
            depth: route.depth,
            bb_coverage: route.bb_coverage,
            cumulative_score: route.cumulative_score,
            tree: bounded.tree as JsonValue,
          }
        })
        return {
          kind: 'plan',
          target: args.target,
          solved: field<boolean>(value, 'solved', false),
          algorithm: field<string>(value, 'algorithm', ''),
          routes: projected,
          // A tree that quietly lost branches would read as a complete route.
          truncatedNodes: truncated,
        }
      },
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `route planning · ${args.target}`,
      kind: 'other',
      rawInput: args,
    }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const value = await runOp(deps, 'plan', {
        target: args.target,
        max_depth: args.max_depth,
        max_routes: args.max_routes,
        exclude_target: args.exclude_target ?? false,
        simplify: args.simplify ?? deps.config.simplifyPlanning,
        algorithm: deps.config.algorithm,
        plausibility: deps.config.plausibility,
        plausibility_threshold: deps.config.plausibilityThreshold,
        time_limit: deps.config.search.timeLimitS,
        max_expansions: deps.config.search.maxExpansions,
      }, exec, deps.config.timeouts.plan)
      return asCanonical(value)
    },
  })
}

export function scoreTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'synomega_score',
    description:
      'Synthesizability score (SynScore) for one TARGET: a continuous 0-1 number for how makeable ' +
      'it is, from one route search. Use to rank candidate molecules by ease of synthesis, or to ' +
      'answer "can this be made, and how hard is it?". score = 1/(U+1)^U where U is the number of ' +
      'non-purchasable starting materials in the best route: 1.0 solved, 0.5 one missing, 0.11 two, ' +
      '0 no route at all. Use `solved` (boolean) to compare against published solve rates.',
    parameters: {
      target: { type: 'string', required: true, description: 'Target SMILES.' },
      max_steps: { type: 'integer', description: 'Longest route allowed, 1-12. Default 5.' },
      exclude_target: {
        type: 'boolean',
        description: 'Treat the target as not purchasable even if it is a catalogue item.',
      },
      original: {
        type: 'boolean',
        description:
          'Score with the unconstrained single-step model instead of the simplification-constrained ' +
          'one. The constrained model is the recommended scoring configuration; leave this off ' +
          'unless comparing the two.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          smiles: { type: 'string' },
          score: { type: 'number', description: 'SynScore, 0-1; higher is easier to make.' },
          solved: { type: 'boolean' },
          bb_coverage: { type: 'number', description: 'Fraction of best-route leaves that are purchasable.' },
          min_steps: { type: 'integer' },
          min_route_depth: { type: 'integer' },
          num_routes: { type: 'integer' },
          num_leaves: { type: 'integer' },
          num_purchasable_leaves: { type: 'integer' },
          max_steps: { type: 'integer' },
          elapsed_s: { type: 'number' },
          expansions: { type: 'integer' },
          terminated_by: { type: 'string' },
          error: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          best_route: { type: 'json', description: 'Same tree shape as synomega_plan, or null.' },
        },
      },
      render: (args, value) => {
        const score = field<number>(value, 'score', 0)
        const solved = field<boolean>(value, 'solved', false)
        const leaves = field<number>(value, 'num_leaves', 0)
        const purchasable = field<number>(value, 'num_purchasable_leaves', 0)
        const missing = leaves - purchasable
        const head =
          `${args.target}\n` +
          `SynScore ${score.toFixed(4)}  (${solved ? 'solved' : 'unsolved'}; ` +
          `${missing} of ${leaves} starting material(s) not purchasable)\n` +
          `shortest route ${field<number>(value, 'min_steps', 0)} step(s), ` +
          `${field<number>(value, 'num_routes', 0)} route(s), ` +
          `${field<number>(value, 'expansions', 0)} expansions, ` +
          `stopped by ${field<string>(value, 'terminated_by', '?')}`
        const route = field<JsonValue | null>(value, 'best_route', null)
        const steps = route === null ? [] : describeRoute(route).map((line, i) => `  [${i + 1}] ${line}`)
        return text(steps.length > 0 ? `${head}\nbest route:\n${steps.join('\n')}` : head)
      },
      presentationMeta: (args, value) => {
        if (!deps.config.visualize) return null
        const bounded = boundTree(field<JsonValue | null>(value, 'best_route', null), deps.config.maxTreeNodes)
        return {
          kind: 'score',
          target: args.target,
          score: field<number>(value, 'score', 0),
          solved: field<boolean>(value, 'solved', false),
          bbCoverage: field<number>(value, 'bb_coverage', 0),
          minSteps: field<number>(value, 'min_steps', 0),
          numLeaves: field<number>(value, 'num_leaves', 0),
          numPurchasableLeaves: field<number>(value, 'num_purchasable_leaves', 0),
          bestRoute: bounded.tree as JsonValue,
          truncatedNodes: bounded.truncated,
        }
      },
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `synthesizability · ${args.target}`,
      kind: 'other',
      rawInput: args,
    }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const value = await runOp(deps, 'score', {
        target: args.target,
        max_steps: args.max_steps,
        exclude_target: args.exclude_target ?? false,
        original: args.original ?? false,
        time_limit: deps.config.search.timeLimitS,
        max_expansions: deps.config.search.maxExpansions,
      }, exec, deps.config.timeouts.score)
      return asCanonical(value)
    },
  })
}
