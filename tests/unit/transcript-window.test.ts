import { describe, expect, it } from 'bun:test'
import {
  INITIAL_RENDER_CAP,
  PAGE_SIZE,
  hasOlderTurns,
  pageOffsetForMessage,
  transcriptWindowStart,
} from '@solus/workspace-ui/components/conversation/lib/transcript-window'

/**
 * The transcript mounts a window at its tail and widens it a page at a time.
 * Two things read the same arithmetic and must agree: what gets rendered, and
 * whether the affordances that widen it are offered. When they disagree the
 * failure is silent — either a "Load earlier turns" button that loads nothing,
 * or older turns that exist with no way to reach them.
 */

describe('transcriptWindowStart', () => {
  it('mounts a short transcript whole', () => {
    expect(transcriptWindowStart(0, 0)).toBe(0)
    expect(transcriptWindowStart(INITIAL_RENDER_CAP, 0)).toBe(0)
  })

  it('holds the tail once the transcript passes the cap', () => {
    expect(transcriptWindowStart(INITIAL_RENDER_CAP + 40, 0)).toBe(40)
  })

  it('reaches one page further back per offset', () => {
    const total = INITIAL_RENDER_CAP + PAGE_SIZE * 3
    expect(transcriptWindowStart(total, 0)).toBe(PAGE_SIZE * 3)
    expect(transcriptWindowStart(total, 1)).toBe(PAGE_SIZE * 2)
    expect(transcriptWindowStart(total, 3)).toBe(0)
  })

  it('clamps rather than slicing from a negative index', () => {
    // Reveal-all sets an offset past the end; a negative start would slice from
    // the tail and mount the wrong messages.
    expect(transcriptWindowStart(10, 99)).toBe(0)
  })
})

describe('hasOlderTurns', () => {
  it('is true while anything precedes the mounted window', () => {
    expect(hasOlderTurns(INITIAL_RENDER_CAP + 1, 0, false)).toBe(true)
  })

  it('is true when the rest is still on the host disk, even with all of it mounted', () => {
    // This is the case a client sees after restoring a long session: every
    // message it holds is rendered, and there are thousands more on disk.
    expect(transcriptWindowStart(10, 0)).toBe(0)
    expect(hasOlderTurns(10, 0, true)).toBe(true)
  })

  it('is false once the window reaches the first message and disk is exhausted', () => {
    expect(hasOlderTurns(INITIAL_RENDER_CAP, 0, false)).toBe(false)
    expect(hasOlderTurns(INITIAL_RENDER_CAP + PAGE_SIZE, 1, false)).toBe(false)
  })
})

describe('pageOffsetForMessage', () => {
  it('asks for no page when the message is already in the window', () => {
    // Find and the minimap widen the window before scrolling; a message in the
    // tail needs no widening at all.
    expect(pageOffsetForMessage(INITIAL_RENDER_CAP + PAGE_SIZE, INITIAL_RENDER_CAP + 10)).toBe(0)
  })

  it('reaches far enough back to put the message on screen', () => {
    const total = INITIAL_RENDER_CAP + PAGE_SIZE * 2
    const offset = pageOffsetForMessage(total, 0)
    expect(transcriptWindowStart(total, offset)).toBe(0)
  })

  it('never returns a negative page for a message past the end', () => {
    expect(pageOffsetForMessage(50, 80)).toBe(0)
  })
})
