/**
 * Browser half of the SynOmega plugin: the tool cards.
 *
 * `tool.call.toolview` is a keyed slot dispatched by wire tool name, so owning
 * how a SynOmega call renders is a registration, not a fork of the conversation
 * renderer. Nothing here talks to the host: every card is drawn from the
 * presentation metadata already persisted on the tool result, which is what
 * makes an old conversation replay identically.
 *
 * @module dsh-synomega/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only side-effect import: `tool.call.toolview` is declared on SlotMap by
// the tool UI package, and without this the key does not exist for us.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { SynomegaToolView } from './cards.tsx'

export const name = 'dsh-synomega-client'

export const inject = ['slots']

/** Wire tool names this package owns the presentation of. */
export const SYNOMEGA_TOOL_NAMES = [
  'synomega_retro',
  'synomega_forward',
  'synomega_plan',
  'synomega_score',
  'synomega_evolve',
] as const

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('tool.call.toolview', () => {
    const disposers = SYNOMEGA_TOOL_NAMES.map((toolName) => ctx.slots.register(
      { name: 'tool.call.toolview', key: toolName },
      SynomegaToolView,
    ))
    return () => { for (const dispose of disposers) dispose() }
  })
}
