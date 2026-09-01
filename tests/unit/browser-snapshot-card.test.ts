import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Message } from '@solus/contracts/types'
import type { BrowserSnapshotRef } from '@solus/contracts/browser-types'
import { snapshotViewportLabel } from '@solus/contracts/browser-types'
import { buildTurns, groupMessages } from '@solus/workspace-ui/components/conversation/lib/turns'
import {
  snapshotAddress,
  snapshotCaption,
  snapshotErrorLabel,
  snapshotFacts,
  snapshotStamp,
  snapshotTitle,
} from '@solus/workspace-ui/components/browser/lib/snapshot-card'

const cardSource = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/components/browser/BrowserSnapshotCard.svelte'),
  'utf8',
)

/**
 * The snapshot card exists because tool output never reaches a client: without
 * it a visual check leaves nothing visual behind, and the user has to take the
 * agent's word for what it saw. These tests encode what the card must say for
 * that to be worth looking at.
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

describe('what a snapshot card says', () => {
  test('keeps its header and footer below transcript body text at each display size', () => {
    // WHY: the screenshot is the evidence and must remain the visual focus. The
    // transcript meta rung is 12px on desktop and 11px on a precise-pointer
    // laptop, so the card chrome does not grow into a second message body.
    expect(cardSource).toContain('class="text-transcript-meta browser-snapshot-card')
    expect(cardSource).not.toContain('class="text-workspace-chrome browser-snapshot-card')
  })

  test('names the device it was captured as, not just the page', () => {
    // WHY: the same page at two viewports produces two very different pictures.
    // A caption that never says which device this was makes a set of captures
    // unreadable. The size itself rides on the picture, in the plate badge.
    expect(snapshotCaption(snapshot())).toContain('iPhone 15')
  })

  test('names the server it came from, in the footer address', () => {
    // WHY: two worktrees serving the same app produce identical screenshots and
    // differ only by port, so the origin is the one thing that says which of
    // them the agent was actually looking at. It is stated once, beside the
    // route it was captured on, rather than twice on one card.
    expect(snapshotAddress(snapshot())).toBe('localhost:5173/')
    expect(snapshotAddress(snapshot({ url: 'not a url' }))).toBe('not a url')
  })

  test('stamps the frame with the size and the colour scheme it was taken under', () => {
    // WHY: a frame is evidence, and those two facts are the ones a reader cannot
    // recover from the pixels a day later. `system` is a mode rather than a
    // rendering — the picture already shows which way it resolved — so stating
    // it would be noise on every capture that never chose.
    expect(snapshotStamp(snapshot({ appearance: 'dark' }))).toBe('393×852 · dark')
    expect(snapshotStamp(snapshot({ appearance: 'system' }))).toBe('393×852')
  })

  test('counts elements in words that survive a count of one', () => {
    expect(snapshotCaption(snapshot({ elementCount: 1 }))).toContain('1 element')
    expect(snapshotCaption(snapshot({ elementCount: 1 }))).not.toContain('1 elements')
    expect(snapshotCaption(snapshot({ elementCount: 9 }))).toContain('9 elements')
  })

  test('shows console errors, and stays silent when there are none', () => {
    // WHY: a page can look correct and be broken, and that is the one fact the
    // picture cannot carry. A badge that is always present teaches people to
    // stop reading it, so zero has to render nothing at all.
    expect(snapshotErrorLabel(snapshot({ consoleErrors: 3 }))).toBe('3 console errors')
    expect(snapshotErrorLabel(snapshot({ consoleErrors: 1 }))).toBe('1 console error')
    expect(snapshotErrorLabel(snapshot({ consoleErrors: 0 }))).toBeNull()
  })

  test('falls back to the address, then to a name, rather than rendering blank', () => {
    // WHY: a page that never set a title is ordinary, and an empty heading over
    // a screenshot reads as a broken card rather than an untitled page.
    expect(snapshotTitle(snapshot({ title: '' }))).toBe('http://localhost:5173/')
    expect(snapshotTitle(snapshot({ title: '', url: '' }))).toBe('Browser')
  })
})

describe('the shape a capture is shown in', () => {
  test('splits the contract label into the device and the size it states', () => {
    // WHY: the contract formats one label so nothing can describe a capture two
    // ways. The card shows its halves in two places — device in the caption,
    // size on the picture — and that has to stay an arrangement here rather
    // than a second format the pane has never heard of.
    const facts = snapshotFacts(snapshot())
    expect(facts.device).toBe('iPhone 15')
    expect(facts.size).toBe('393×852')
  })

  test('takes the shape of the capture, so the card is never a field of empty ground', () => {
    // WHY: the card's width is computed from this ratio. A card that kept a
    // fixed width would mat every capture that is not the shape of the pane —
    // which is what a near-square screenshot in a wide transcript looks like.
    // It is also what holds the shape before the asset store answers, so a
    // capture landing mid-turn cannot shove the transcript under the reader.
    expect(snapshotFacts(snapshot({ viewport: 'Desktop — 1440×900' })).aspectRatio).toBe(
      `${1440 / 900}`,
    )
  })

  test('refuses a shape no caption could be read under', () => {
    // WHY: a full-page capture is many screens long and a panorama is many
    // wide. Past either end what is extreme is the page, not the device, and a
    // card shaped like that has no room left for what it is a card of.
    expect(snapshotFacts(snapshot()).aspectRatio).toBe('0.5')
    expect(snapshotFacts(snapshot({ viewport: 'Wall — 5120×1000' })).aspectRatio).toBe('3')
  })

  test('reads the device class off the width, for the glyph beside the title', () => {
    expect(snapshotFacts(snapshot()).deviceKind).toBe('phone')
    expect(snapshotFacts(snapshot({ viewport: 'iPad — 820×1180' })).deviceKind).toBe('tablet')
    expect(snapshotFacts(snapshot({ viewport: 'Laptop — 1440×900' })).deviceKind).toBe('desktop')
  })

  test('still renders a label that states no size', () => {
    // WHY: a custom viewport can name its numbers and nothing else. A card that
    // needed the separator would render an empty chip over the picture.
    const facts = snapshotFacts(snapshot({ viewport: 'Custom' }))
    expect(facts.device).toBe('Custom')
    expect(facts.size).toBe('')
    // A bare number, because the card multiplies it in a calc() to reach its
    // own width — a `16 / 10` would be valid for aspect-ratio and nothing else.
    expect(facts.aspectRatio).toBe('1.6')
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

  test('gathers a whole capture pass into one item, across the tool rows between frames', () => {
    // WHY: every capture is a tool call followed by its snapshot message, so
    // the frames of one pass are never adjacent in the raw transcript. Grouping
    // that stopped at a tool row would leave a pass of three as three cards
    // repeating the same header, viewport and footer down the conversation.
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

    expect(plates).toHaveLength(1)
    expect(plates[0]?.kind === 'browser-snapshot' && plates[0].messages.map((m) => m.id))
      .toEqual(['s1', 's2', 's3'])
  })

  test('starts a second plate once the agent has spoken', () => {
    // WHY: a pass is one act of looking. Captures taken after the agent has said
    // something about the first batch are a second look, and merging them would
    // put frames above the sentence that was written before they existed.
    const messages: Message[] = [
      { id: 's1', role: 'assistant', content: '', browserSnapshot: snapshot(), timestamp: 1 },
      { id: 's2', role: 'assistant', content: '', browserSnapshot: snapshot(), timestamp: 2 },
      { id: 'a1', role: 'assistant', content: 'Both look right. Now the wide one.', timestamp: 3 },
      { id: 's3', role: 'assistant', content: '', browserSnapshot: snapshot(), timestamp: 4 },
    ]

    const plates = groupMessages(messages).filter((item) => item.kind === 'browser-snapshot')

    expect(plates).toHaveLength(2)
    expect(plates[0]?.kind === 'browser-snapshot' && plates[0].messages).toHaveLength(2)
    expect(plates[1]?.kind === 'browser-snapshot' && plates[1].messages).toHaveLength(1)
  })

  test('renders the plate at the position of the first frame, not the last', () => {
    // WHY: the tool rows between captures are flushed as the pass proceeds. If
    // the plate were pushed on the last frame it would land below rows that
    // describe work it is the result of.
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

    expect(turn?.body.map((item) => item.kind)).toContain('browser-snapshot')
    expect(turn?.visibleWhenCollapsed.map((item) => item.kind)).toContain('browser-snapshot')
  })
})
