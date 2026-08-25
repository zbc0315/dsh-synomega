/**
 * The prompt section that teaches the model when to reach for which tool.
 *
 * It is deliberately static: a section whose text never changes stays inside the
 * reusable prompt prefix, so it costs cache-warm tokens rather than a fresh
 * prefill every turn. Anything that varies per call belongs in a tool result.
 */

/** Prompt order: tool guidance sits in the 100-199 band by convention. */
export const SYNOMEGA_SECTION_ORDER = 140

export const SYNOMEGA_SECTION_NAME = 'synomega:tool-guidance'

export const SYNOMEGA_GUIDANCE = `## Chemistry: SynOmega tools

Five tools predict organic reactions locally. Match the tool to the question:

- "how do I make X" / "give me a route" -> synomega_plan
- "can X be made" / "rank these by ease of synthesis" -> synomega_score (SynScore, 0-1)
- "what reacts to give X" / "how is this bond formed" -> synomega_retro
- "what do these reactants give" / "what is the outcome" -> synomega_forward
- "what can this mixture form" / one-pot or multicomponent chemistry -> synomega_evolve

Rules:
- Every molecule argument is a SMILES string. If the user gives a name, resolve it to SMILES first, or ask. Dot-separate multiple molecules.
- Start at the default depth and top-k. Raise them only when the default finds nothing; larger budgets are much slower.
- The first call after installation downloads a few hundred MB of model weights and can take minutes. If a tool says setup is in progress, wait and retry rather than switching approach.
- Predictions are ranked candidates, not guarantees. Report scores alongside structures, and say when a route is unsolved rather than presenting a partial route as complete.
- Retrosynthesis is dual-use. General or educational discussion of chemistry differs from actionable route and procurement assistance for a specific hazardous, controlled, or weaponizable target. For high-risk targets, defer to this deployment's safety policy instead of planning on autopilot; surface the concern when a request looks like it seeks a usable route to a dangerous substance.`
