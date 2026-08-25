/**
 * The benzene button in the composer, and the editor behind it.
 *
 * Typing a SMILES string by hand is the one part of using this plugin that a
 * chemist has no reason to tolerate: the structure is obvious on paper and
 * fiddly as text, and a transcription slip produces a different molecule that
 * still parses. So the composer gets a seat that opens Ketcher, and what comes
 * back is appended to whatever the user was already writing rather than
 * replacing it — the drawing is one noun in a sentence, not the whole message.
 *
 * The editor is served from this harness's own origin (see `src/ketcher.ts`),
 * which is what lets the dialog read the drawn structure straight off the
 * frame's `ketcher` object instead of inventing a message protocol.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, ReactElement } from 'react'
import { KETCHER_APP_PATH, KETCHER_STATE_PATH, type KetcherState } from '../shared/ketcher.ts'

/** How often the dialog re-asks while the editor is still being installed. */
const POLL_MS = 1200

/** The Ketcher instance the editor publishes on its own window. */
interface KetcherApi {
  getSmiles(extended?: boolean): Promise<string>
}

/**
 * The props this seat actually reads.
 *
 * The composer hands every input-zone entry the conversation snapshot and the
 * live input state; only the draft and the write verb matter here, so the seat
 * is typed against that subset and stays renderable in a test.
 */
export interface ComposerSeatProps {
  input: { draft: string, phase: string }
  inputActions: { setDraft(text: string): void }
}

/**
 * Append a drawn structure to the draft.
 *
 * A SMILES string run onto the end of a word is a different string, so a
 * separator is added unless the draft already ends in whitespace. Appending
 * rather than replacing also leaves every reference chip in the draft at its
 * recorded offset.
 */
export function appendSmiles(draft: string, smiles: string): string {
  if (draft === '') return smiles
  return /\s$/.test(draft) ? `${draft}${smiles}` : `${draft} ${smiles}`
}

/** Aromatic ring: the one glyph that reads as "draw a molecule" at 16 pixels. */
function BenzeneIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <polygon
        points="8,2.2 13,5.1 13,10.9 8,13.8 3,10.9 3,5.1"
        fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2.9" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

/**
 * The composer seat: one round button matching the resident chrome beside it.
 *
 * Sizing and tokens are copied from the composer's own leading control rather
 * than invented, so the row keeps one rhythm when the theme changes.
 */
export function KetcherSeat(props: ComposerSeatProps): ReactElement {
  const [open, setOpen] = useState(false)
  const busy = props.input.phase === 'submitting'

  const draft = props.input.draft
  const actions = props.inputActions
  const insert = useCallback((smiles: string) => {
    actions.setDraft(appendSmiles(draft, smiles))
    setOpen(false)
  }, [draft, actions])

  return (
    <>
      <button
        type="button"
        title="Draw a molecule"
        aria-label="Draw a molecule"
        aria-haspopup="dialog"
        disabled={busy}
        onMouseDown={(event) => { event.preventDefault() }}
        onClick={() => { setOpen(true) }}
        style={{
          width: 28,
          height: 28,
          display: 'grid',
          placeItems: 'center',
          flex: 'none',
          border: 'none',
          borderRadius: 999,
          cursor: busy ? 'default' : 'pointer',
          opacity: busy ? 0.5 : 1,
          background: 'var(--dsw-specific-selector, transparent)',
          color: 'var(--dsw-alias-label-primary, currentColor)',
        }}
      >
        <BenzeneIcon />
      </button>
      {open ? <KetcherDialog onCancel={() => { setOpen(false) }} onInsert={insert} /> : null}
    </>
  )
}

const MASK: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.4))',
  backdropFilter: 'var(--dsw-mask-blur, blur(10px))',
}

const CARD: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: 'min(1120px, 94vw)',
  height: 'min(780px, 90vh)',
  borderRadius: 16,
  overflow: 'hidden',
  background: 'var(--dsw-alias-bg-layer-1, #fff)',
  color: 'var(--dsw-alias-label-primary, inherit)',
  boxShadow: 'var(--dsw-shadow-lv3, 0 12px 48px rgba(0, 0, 0, 0.3))',
}

const BUTTON_BASE: CSSProperties = {
  height: 32,
  padding: '0 16px',
  borderRadius: 999,
  border: 'none',
  fontSize: 13,
  cursor: 'pointer',
}

const GHOST_BUTTON: CSSProperties = {
  ...BUTTON_BASE,
  background: 'var(--dsw-specific-selector, rgba(127, 127, 127, 0.15))',
  color: 'var(--dsw-alias-label-primary, inherit)',
}

const PRIMARY_BUTTON: CSSProperties = {
  ...BUTTON_BASE,
  background: 'var(--dsw-alias-button-primary-fill, #4d6bfe)',
  color: 'var(--dsw-alias-label-primary-foreground, #fff)',
}

/**
 * The dialog.
 *
 * Two different things can keep the editor from being usable, and they are
 * reported separately because the remedies differ: the assets may still be
 * downloading (wait, or check the network), or the frame may not have finished
 * booting (just wait). Neither is an error until the user tries to insert.
 */
export function KetcherDialog(props: {
  onCancel: () => void
  onInsert: (smiles: string) => void
  /** Test seam: how the drawn structure is read out of the frame. */
  readSmiles?: (frame: HTMLIFrameElement) => Promise<string>
}): ReactElement {
  const [state, setState] = useState<KetcherState | null>(null)
  const [booted, setBooted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const frameRef = useRef<HTMLIFrameElement | null>(null)

  const { onCancel, onInsert, readSmiles } = props

  // Asking for the state is also what starts the download, so the first open of
  // the dialog is what pays for the editor and every later one is instant.
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(KETCHER_STATE_PATH, { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`the editor route answered ${response.status}`)
        const next = await response.json() as KetcherState
        if (!live) return
        setState(next)
        if (next.phase === 'ready' || next.phase === 'disabled') return
      } catch (cause: unknown) {
        if (!live) return
        setState({ phase: 'failed', detail: cause instanceof Error ? cause.message : String(cause), version: '' })
      }
      timer = setTimeout(() => { void poll() }, POLL_MS)
    }
    void poll()
    return () => { live = false; if (timer !== undefined) clearTimeout(timer) }
  }, [])

  // The editor announces itself to whoever framed it; anything else on the
  // message bus belongs to someone else.
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (frameRef.current === null || event.source !== frameRef.current.contentWindow) return
      const data: unknown = event.data
      if (typeof data === 'object' && data !== null && (data as { eventType?: unknown }).eventType === 'init') {
        setBooted(true)
      }
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [onCancel])

  const confirm = useCallback(async (): Promise<void> => {
    const frame = frameRef.current
    if (frame === null) return
    setBusy(true)
    setError(null)
    try {
      const smiles = (await (readSmiles ?? defaultReadSmiles)(frame)).trim()
      if (smiles === '') {
        setError('The canvas is empty — draw a structure first.')
        return
      }
      onInsert(smiles)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [onInsert, readSmiles])

  const phase = state?.phase
  const settled = booted && !busy

  return createPortal(
    <div
      style={MASK}
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}
    >
      <div style={CARD} role="dialog" aria-modal="true" aria-label="Draw a molecule">
        <header style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '12px 16px', flex: 'none' }}>
          <strong style={{ fontSize: 13 }}>Draw a molecule</strong>
          <span style={{ fontSize: 11, opacity: 0.6 }}>the structure is inserted into the message as SMILES</span>
        </header>
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {phase === 'ready'
            ? (
              <iframe
                ref={frameRef}
                src={KETCHER_APP_PATH}
                title="Ketcher molecule editor"
                style={{ border: 'none', width: '100%', height: '100%', background: '#fff' }}
              />
              )
            : (
              <p style={{ margin: 'auto', padding: 24, textAlign: 'center', fontSize: 13, opacity: 0.75 }}>
                {state === null ? 'Contacting the editor…' : describe(state)}
              </p>
              )}
        </div>
        <footer style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', flex: 'none' }}>
          <span style={{
            flex: 1,
            fontSize: 12,
            color: error === null ? 'inherit' : 'var(--dsw-alias-state-error-primary, #c33)',
            opacity: error === null ? 0.6 : 1,
          }}>
            {error ?? (phase === 'ready' && !booted ? 'Starting the editor…' : '')}
          </span>
          <button type="button" onClick={onCancel} style={GHOST_BUTTON}>Cancel</button>
          <button
            type="button"
            disabled={!settled}
            onClick={() => { void confirm() }}
            style={{ ...PRIMARY_BUTTON, opacity: settled ? 1 : 0.5, cursor: settled ? 'pointer' : 'default' }}
          >
            Insert
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

/** Read the drawn structure from a same-origin editor frame. */
async function defaultReadSmiles(frame: HTMLIFrameElement): Promise<string> {
  const api = (frame.contentWindow as (Window & { ketcher?: KetcherApi }) | null)?.ketcher
  if (api === undefined) throw new Error('The editor has not finished loading.')
  return await api.getSmiles()
}

/** One sentence a user can act on, for every phase that is not "ready". */
function describe(state: KetcherState): string {
  switch (state.phase) {
    case 'disabled': return 'The molecule editor is turned off in this deployment.'
    case 'downloading': return `Downloading the editor — ${state.detail}. This happens once.`
    case 'extracting': return 'Unpacking the editor…'
    case 'failed': return `The editor could not be installed: ${state.detail}`
    default: return 'Preparing the editor…'
  }
}
