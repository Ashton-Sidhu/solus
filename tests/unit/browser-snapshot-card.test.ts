import { describe, expect, test } from 'bun:test'
import type { Message } from '@solus/contracts/types'
import type { BrowserSnapshotRef } from '@solus/contracts/browser-types'
import { snapshotViewportLabel } from '@solus/contracts/browser-types'
import { buildTurns, groupMessages } from '@solus/workspace-ui/components/conversation/lib/turns'
import { snapshotAddress } from '@solus/workspace-ui/components/browser/lib/snapshot-card'

/**
 * A capture shows in the transcript because tool output never reaches a client:
 * without it a visual check leaves nothing visual behind, and the user has to
 * take the agent's word for what it saw.
 */

function snapshot(overrides: Partial<BrowserSnapshotRef> = {}): BrowserSnapshotRef {
  return {
    browserPageId: 'browser_1',
    assetId: 'a'.repeat(64) + '.png',
    url: 'http://localhost:5173/',
    title: 'Solus',
    viewport: 'iPhone 15 — 393×852',
    appearance: 'light',
    elementCount: 9,
    consoleErrors: 0,
    capturedAt: 1,
    ...overrides,
  }
}

describe('what the viewer says about a capture', () => {
  test('names the server it came from, in the address under its name', () => {
    // WHY: two worktrees serving the same app produce identical screenshots and
    // differ only by port, so the origin is the one thing that says which of
    // them the agent was actually looking at.
    expect(snapshotAddress(snapshot())).toBe('localhost:5173/')
    expect(snapshotAddress(snapshot({ url: 'not a url' }))).toBe('not a url')
  })
})

describe('the viewport label a capture carries', () => {
  test('states the device and its size together', () => {
    // WHY: formatted once in the contract so the pane, the agent's transcript,
    // and the card cannot describe one capture three different ways.
    expect(snapshotViewportLabel({
      mode: 'preset',
      presetId: 'iphone-15',
      orientation: 'portrait',
      width: 393,
      height: 852,
      deviceScaleFactor: 3,
      hasTouch: true,
    })).toBe('iPhone 15 — 393×852')
  })
})

describe('a capture in the transcript', () => {
  test('is its own item, so it renders as a picture rather than a tool row', () => {
    // WHY: the grouping is what decides whether the conversation shows the
    // image at all. A snapshot message that fell through to the assistant
    // branch would render as an empty text bubble.
    const message: Message = {
      id: 'm1',
      role: 'assistant',
      content: '',
      browserSnapshot: snapshot(),
      timestamp: 1,
    }

    const grouped = groupMessages([message])

    expect(grouped).toHaveLength(1)
    expect(grouped[0]?.kind).toBe('browser-snapshot')
  })

  test('keeps captures separate for the bottom card row', () => {
    // Each capture is a separate card in the turn's image row, even when tool
    // calls separate them. Grouping must not merge their identities.
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Compare the three pages', timestamp: 1 },
      { id: 't1', role: 'tool', content: 'browser_snapshot', timestamp: 2 },
      { id: 's1', role: 'assistant', content: '', browserSnapshot: snapshot(), timestamp: 3 },
      { id: 't2', role: 'tool', content: 'browser_snapshot', timestamp: 4 },
      { id: 's2', role: 'assistant', content: '', browserSnapshot: snapshot(), timestamp: 5 },
      { id: 't3', role: 'tool', content: 'browser_snapshot', timestamp: 6 },
      { id: 's3', role: 'assistant', content: '', browserSnapshot: snapshot(), timestamp: 7 },
    ]

    const plates = groupMessages(messages).filter((item) => item.kind === 'browser-snapshot')

    expect(plates).toHaveLength(3)
    expect(plates.flatMap((item) => item.kind === 'browser-snapshot' ? item.messages.map((m) => m.id) : []))
      .toEqual(['s1', 's2', 's3'])
  })

  test('keeps capture order when the agent speaks between captures', () => {
    // Prose and other outcomes must not change the order of image cards.
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Check the pages', timestamp: 0 },
      { id: 's1', role: 'assistant', content: '', browserSnapshot: snapshot(), timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'That looks right. Now the wide one.', timestamp: 2 },
      { id: 's2', role: 'assistant', content: '', browserSnapshot: snapshot(), timestamp: 3 },
      { id: 'w1', role: 'assistant', content: '', workRef: { workId: 'w', title: 'Notes' }, timestamp: 4 },
      { id: 's3', role: 'assistant', content: '', browserSnapshot: snapshot(), timestamp: 5 },
    ]

    const grouped = groupMessages(messages)
    const plates = grouped.filter((item) => item.kind === 'browser-snapshot')

    expect(plates).toHaveLength(3)
    expect(plates.flatMap((item) => item.kind === 'browser-snapshot' ? item.messages.map((m) => m.id) : []))
      .toEqual(['s1', 's2', 's3'])
    expect(grouped.map((item) => item.kind)).toEqual(['user', 'browser-snapshot', 'assistant', 'browser-snapshot', 'document', 'browser-snapshot'])
  })

  test('starts a new plate for a new turn', () => {
    // WHY: a new prompt is a new request. Its captures answer it, so they must
    // not be appended to the plate of an earlier turn far up the conversation.
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Check the page', timestamp: 0 },
      { id: 's1', role: 'assistant', content: '', browserSnapshot: snapshot(), timestamp: 1 },
      { id: 'u2', role: 'user', content: 'Now the wide one', timestamp: 2 },
      { id: 's2', role: 'assistant', content: '', browserSnapshot: snapshot(), timestamp: 3 },
    ]

    const plates = groupMessages(messages).filter((item) => item.kind === 'browser-snapshot')

    expect(plates).toHaveLength(2)
  })

  test('preserves capture order before turn building moves cards below the reply', () => {
    // Grouping preserves the source order; the turn owns image placement.
    const messages: Message[] = [
      { id: 't1', role: 'tool', content: 'browser_snapshot', timestamp: 1 },
      { id: 's1', role: 'assistant', content: '', browserSnapshot: snapshot(), timestamp: 2 },
      { id: 't2', role: 'tool', content: 'browser_snapshot', timestamp: 3 },
      { id: 's2', role: 'assistant', content: '', browserSnapshot: snapshot(), timestamp: 4 },
    ]

    expect(groupMessages(messages).map((item) => item.kind)).toEqual([
      'tool-group',
      'browser-snapshot',
      'tool-group',
      'browser-snapshot',
    ])
  })

  test('stays visible after its completed turn collapses', () => {
    // WHY: the capture is the result the user asked for, not intermediate agent
    // activity. Hiding it behind the turn disclosure would make the visual proof
    // disappear as soon as the agent finished explaining it.
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Take a screenshot', timestamp: 1 },
      {
        id: 's1',
        role: 'assistant',
        content: '',
        browserSnapshot: snapshot(),
        timestamp: 2,
      },
      { id: 'a1', role: 'assistant', content: 'The page looks correct.', timestamp: 3 },
    ]

    const [turn] = buildTurns(groupMessages(messages), { running: false })

    expect(turn?.body).toEqual([])
    expect(turn?.visibleWhenCollapsed).toEqual([])
    expect(turn?.images.filter((message) => message.browserSnapshot).map((message) => message.id)).toEqual(['s1'])
    expect(turn?.tail.map((item) => item.kind)).toEqual(['assistant'])
  })
})
