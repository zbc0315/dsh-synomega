/**
 * The composer seat and its dialog, in jsdom.
 *
 * What is pinned here is the behaviour a chemist would notice: the drawn
 * structure lands in the message they were already writing instead of
 * replacing it, an empty canvas says so rather than inserting nothing, and the
 * dialog explains a still-downloading editor instead of showing a dead frame.
 * jsdom never runs Ketcher itself — the editor is stubbed on the frame exactly
 * where the real one publishes itself.
 */

import 'global-jsdom/register'
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { KetcherSeat, appendSmiles } from '../src/client/Ketcher.tsx'
import type { KetcherState } from '../src/shared/ketcher.ts'

afterEach(() => { cleanup(); delete (globalThis as Record<string, unknown>)['fetch'] })

/** Answer the dialog's state poll with one fixed phase. */
function stubState(state: KetcherState): void {
  ;(globalThis as Record<string, unknown>)['fetch'] = async () => ({
    ok: true,
    json: async () => state,
  })
}

function seat(draft: string, drafts: string[]) {
  return (
    <KetcherSeat
      useInput={(selector) => selector({ draft, phase: 'plain' })}
      inputActions={{ setDraft: (text: string) => { drafts.push(text) } }}
    />
  )
}

/** Open the dialog, wait for the frame, and publish a stub editor on it. */
async function openWithEditor(getSmiles: () => Promise<string>): Promise<HTMLIFrameElement> {
  fireEvent.click(screen.getByLabelText('Draw a molecule'))
  const frame = await waitFor(() => screen.getByTitle('Ketcher molecule editor') as HTMLIFrameElement)
  const inner = frame.contentWindow as (Window & { ketcher?: unknown }) | null
  ok(inner !== null, 'jsdom should give the frame a window')
  inner.ketcher = { getSmiles }
  // Node's own MessageEvent constructor refuses a Window as `source`, so the
  // event the editor really sends is assembled on jsdom's Event instead.
  const announcement = new window.Event('message')
  Object.assign(announcement, { data: { eventType: 'init' }, source: inner })
  fireEvent(window, announcement)
  await waitFor(() => { ok(!(screen.getByText('Insert') as HTMLButtonElement).disabled) })
  return frame
}

test('a drawn structure is appended to the draft, not substituted for it', async () => {
  stubState({ phase: 'ready', detail: 'ready', version: '3.17.0' })
  const drafts: string[] = []
  render(seat('which of these is easier to make?', drafts))

  await openWithEditor(async () => 'c1ccccc1O')
  fireEvent.click(screen.getByText('Insert'))

  await waitFor(() => { deepStrictEqual(drafts, ['which of these is easier to make? c1ccccc1O']) })
  // Inserting closes the dialog: the user is back in the message they were writing.
  strictEqual(screen.queryByTitle('Ketcher molecule editor'), null)
})

test('an empty canvas says so instead of inserting nothing', async () => {
  stubState({ phase: 'ready', detail: 'ready', version: '3.17.0' })
  const drafts: string[] = []
  render(seat('', drafts))

  await openWithEditor(async () => '   ')
  fireEvent.click(screen.getByText('Insert'))

  await waitFor(() => { ok(screen.getByText(/canvas is empty/i)) })
  deepStrictEqual(drafts, [])
})

test('an editor still downloading is explained, and no frame is mounted', async () => {
  stubState({ phase: 'downloading', detail: 'downloading Ketcher 3.17.0 (about 35 MB)', version: '3.17.0' })
  render(seat('', []))
  fireEvent.click(screen.getByLabelText('Draw a molecule'))

  await waitFor(() => { ok(screen.getByText(/Downloading the editor/)) })
  strictEqual(screen.queryByTitle('Ketcher molecule editor'), null)
  ok((screen.getByText('Insert') as HTMLButtonElement).disabled)
})

test('Cancel leaves the draft alone', async () => {
  stubState({ phase: 'ready', detail: 'ready', version: '3.17.0' })
  const drafts: string[] = []
  render(seat('untouched', drafts))

  await openWithEditor(async () => 'CCO')
  fireEvent.click(screen.getByText('Cancel'))

  await waitFor(() => { strictEqual(screen.queryByTitle('Ketcher molecule editor'), null) })
  deepStrictEqual(drafts, [])
})

test('the separator is added only when the draft needs one', () => {
  strictEqual(appendSmiles('', 'CCO'), 'CCO')
  strictEqual(appendSmiles('score', 'CCO'), 'score CCO')
  strictEqual(appendSmiles('score ', 'CCO'), 'score CCO')
  strictEqual(appendSmiles('score\n', 'CCO'), 'score\nCCO')
})
