/**
 * The two facts both halves of the plugin need to agree on about Ketcher.
 *
 * The browser half asks a URL for the editor; the host half answers it. Nothing
 * else crosses, so the constant lives in one file that each build bundles its
 * own copy of.
 */

/** Prefix route the host serves the extracted Ketcher SPA under. */
export const KETCHER_ROUTE = '/dsh-synomega/ketcher'

/** Provisioning state of the editor assets, as JSON. */
export const KETCHER_STATE_PATH = `${KETCHER_ROUTE}/__state`

/** Entry document of the editor. */
export const KETCHER_APP_PATH = `${KETCHER_ROUTE}/index.html`

export type KetcherPhase = 'disabled' | 'idle' | 'downloading' | 'extracting' | 'ready' | 'failed'

/** What `__state` answers. */
export interface KetcherState {
  phase: KetcherPhase
  /** One line a human can act on. */
  detail: string
  version: string
}
