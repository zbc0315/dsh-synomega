/**
 * Deployment configuration for the SynOmega plugin.
 *
 * Every value that a deployment might reasonably want different lives here, not
 * in a constant: the test is whether it can be changed from `cordis.yml` without
 * touching code. Model-facing tool arguments stay separate — search *budgets*
 * belong to the deployment, not to the model.
 */

import Schema from '@deepseek-ai/schemastery'

/** Per-operation cooperative timeouts, in milliseconds. */
export interface TimeoutConfig {
  retro: number
  forward: number
  plan: number
  score: number
  evolve: number
}

/** Search budget handed to SynOmega. Not model-facing. */
export interface SearchConfig {
  expansionWidth: number
  timeLimitS: number
  maxExpansions: number
}

export interface Config {
  autoSetup: boolean
  python?: string
  venvDir?: string
  extras: string[]
  downloadAssets: boolean
  mirror: 'auto' | 'ustc' | 'github'
  cacheDir?: string

  plausibility: boolean
  plausibilityThreshold: number
  algorithm: 'retrostar' | 'mcts' | 'bfs'
  simplifyPlanning: boolean
  search: SearchConfig

  queueLimit: number
  timeouts: TimeoutConfig
  workerIdleTimeoutMs: number
  hardKillMs: number

  visualize: boolean
  maxTreeNodes: number
  maxCardItems: number
  systemPrompt: boolean
}

export const Config: Schema<Config> = Schema.object({
  autoSetup: Schema.boolean().default(true)
    .description('Provision the Python environment and prefetch assets on activation.'),
  python: Schema.string()
    .description('Explicit interpreter path (>=3.10). Set it and no virtualenv is created.'),
  venvDir: Schema.string()
    .description('Virtualenv location. Defaults to <DSH_HOME>/plugins/synomega/venv.'),
  extras: Schema.array(Schema.string()).default(['gnn'])
    .description('PyPI extras. [] installs the template-only backend (no torch, much faster).'),
  downloadAssets: Schema.boolean().default(true)
    .description('Run `synomega download` during setup to prefetch models and stock.'),
  mirror: Schema.union(['auto', 'ustc', 'github'] as const).default('auto')
    .description('Asset mirror; maps to SYNOMEGA_MIRROR.'),
  cacheDir: Schema.string().description('Asset cache directory; maps to SYNOMEGA_CACHE.'),

  plausibility: Schema.boolean().default(false)
    .description('Screen single-step candidates with the plausibility model. Off by default: it does not improve top-k recall and adds latency.'),
  plausibilityThreshold: Schema.number().default(0.4),
  algorithm: Schema.union(['retrostar', 'mcts', 'bfs'] as const).default('retrostar'),
  simplifyPlanning: Schema.boolean().default(false)
    .description('Back route planning with the simplification-constrained model. Scoring uses it regardless — that is SynOmega\'s recommended scoring configuration.'),
  search: Schema.object({
    expansionWidth: Schema.number().default(50),
    timeLimitS: Schema.number().default(60),
    maxExpansions: Schema.number().default(500),
  }).default({ expansionWidth: 50, timeLimitS: 60, maxExpansions: 500 }),

  queueLimit: Schema.number().default(8)
    .description('Pending requests allowed before new calls are refused outright.'),
  timeouts: Schema.object({
    retro: Schema.number().default(120_000),
    forward: Schema.number().default(120_000),
    plan: Schema.number().default(600_000),
    score: Schema.number().default(600_000),
    evolve: Schema.number().default(600_000),
  }).default({ retro: 120_000, forward: 120_000, plan: 600_000, score: 600_000, evolve: 600_000 }),
  workerIdleTimeoutMs: Schema.number().default(1_800_000)
    .description('Retire the resident Python worker after this long idle. Zero keeps it forever.'),
  hardKillMs: Schema.number().default(60_000)
    .description('After a call is abandoned, how long to wait before killing the worker outright. Python inference cannot be interrupted cooperatively.'),

  visualize: Schema.boolean().default(true)
    .description('Emit presentation metadata for the browser cards. Off leaves text-only results.'),
  maxTreeNodes: Schema.number().default(120)
    .description('Node cap for a rendered route tree; a larger tree is truncated and labelled as such.'),
  maxCardItems: Schema.number().default(12)
    .description('Predictions or molecules projected into one card.'),
  systemPrompt: Schema.boolean().default(true)
    .description('Register the prompt section that teaches the model when to use each tool.'),
})
