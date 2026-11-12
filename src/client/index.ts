/**
 * Browser half of the SynOmega plugin: the tool cards, and the molecule editor.
 *
 * `tool.call.toolview` is a keyed slot dispatched by wire tool name, so owning
 * how a SynOmega call renders is a registration, not a fork of the conversation
 * renderer. Nothing here talks to the host: every card is drawn from the
 * presentation metadata already persisted on the tool result, which is what
 * makes an old conversation replay identically.
 *
 * The composer seat is the other half of the same idea in the other direction:
 * results come back as pictures, so structures should be able to go out as
 * pictures too.
 *
 * @module dsh-synomega/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only side-effect import: `tool.call.toolview` is declared on SlotMap by
// the tool UI package, and without this the key does not exist for us.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
// Likewise for `conversation.input.left`, the composer's tool-row seat.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// And for `ctx.slots` itself, which the renderer declares on Context.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SynomegaToolView } from './cards.tsx'
import { KetcherSeat, type ComposerSeatProps } from './Ketcher.tsx'

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

  // The seat is declared by the conversation package's composer entry, which
  // may activate after this one: `inject` waits for the declaration instead of
  // racing it.
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
    { name: 'conversation.input.left', id: 'synomega-ketcher', order: 0 },
    // The composed props are a superset of what the seat reads; the seat is
    // typed against its own subset so it stays renderable in a test.
    KetcherSeat as (props: ComposerSeatProps) => ReturnType<typeof KetcherSeat>,
  ))
}
