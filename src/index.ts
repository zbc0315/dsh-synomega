/**
 * DeepSeek Harness plugin: organic reaction prediction through SynOmega.
 *
 * Five model-facing tools over a resident Python worker, plus the prompt section
 * that teaches a model which of them answers which question. The Python side is
 * provisioned in the background at activation; nothing here blocks the harness
 * from booting, and a tool called before provisioning finishes reports the phase
 * instead of failing.
 *
 * @module dsh-synomega
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { Config } from './config.ts'
import { Bootstrap } from './bootstrap.ts'
import { SynomegaWorker } from './worker.ts'
import type { ToolDeps } from './tools/shared.ts'
import { forwardTool, retroTool } from './tools/singlestep.ts'
import { planTool, scoreTool } from './tools/planning.ts'
import { evolveTool } from './tools/evolution.ts'
import { SYNOMEGA_GUIDANCE, SYNOMEGA_SECTION_NAME, SYNOMEGA_SECTION_ORDER } from './prompt.ts'

export { Config } from './config.ts'
export type { BootstrapStatus } from './bootstrap.ts'

export const name = 'dsh-synomega'

/**
 * `tools` and `subprocess` are hard requirements — without either, this plugin
 * has nothing to offer. `systemPrompt` is looked up optionally instead, so a
 * composition that omits it still gets working tools.
 */
export const inject = ['tools', 'subprocess']

/** The one method this plugin needs from the prompt registry. */
interface PromptRegistry {
  section(section: { name: string, order: number, text: string }): () => void
}

/** Directory holding the Python worker, resolved relative to the built entry. */
function workerDirectory(): string {
  // The published layout is lib/index.js next to python/, so the worker sits one
  // level up from the entry point in both the built package and a source run.
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'python')
}

export function apply(ctx: Context, config: Config): void {
  const stateDir = dshHomePath('plugins', 'synomega')
  const bootstrap = new Bootstrap(ctx, config, stateDir, workerDirectory())
  const worker = new SynomegaWorker(ctx, config, () => bootstrap.ensure())
  const deps: ToolDeps = { worker, bootstrap, config }

  for (const tool of [
    retroTool(deps),
    forwardTool(deps),
    planTool(deps),
    scoreTool(deps),
    evolveTool(deps),
  ]) {
    ctx.tools.register(tool)
  }

  if (config.systemPrompt) {
    // Optional by lookup rather than by `inject`, so a composition without the
    // prompt registry still gets working tools. `ctx.get` is loosely typed, so
    // the shape is checked here rather than assumed.
    const systemPrompt = ctx.get('systemPrompt') as PromptRegistry | undefined
    if (typeof systemPrompt?.section === 'function') {
      ctx.effect(() => systemPrompt.section({
        name: SYNOMEGA_SECTION_NAME,
        order: SYNOMEGA_SECTION_ORDER,
        text: SYNOMEGA_GUIDANCE,
      }))
    } else {
      ctx.logger?.info?.('synomega: no usable systemPrompt service; tool guidance was not registered')
    }
  }

  // The worker owns a child process, so its teardown is an explicit effect
  // rather than something left to garbage collection.
  ctx.effect(() => () => { void worker.dispose() })

  bootstrap.start()
}
