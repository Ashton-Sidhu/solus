import { expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import type { PlanComment } from '@solus/contracts/types'
import type { DocCommentThread } from '@solus/contracts/work-comments'
import { measureAnchors } from '@solus/workspace-ui/components/comments/lib/anchors'
import { layoutThreads } from '@solus/workspace-ui/components/comments/lib/rail-layout'
import { railThreads } from '@solus/workspace-ui/components/comments/lib/thread'

/**
 * A linked document has two kinds of conversation on it — the private Solus
 * threads and the ones that live in the provider — and they share the single
 * comments rail. These pin the rule that sorts every external thread into one
 * of the rail's two views: a thread the highlight plugin placed rides its own
 * line in the Inline margin, and one it could not belongs to Page.
 */

function localComment(id: string): PlanComment {
  return { id, selectedText: 'The launch date is Friday.', comment: 'Is that right?' }
}

function externalThread(id: string): DocCommentThread {
  return {
    id,
    text: 'Change the launch date.',
    quote: 'The launch date is Friday.',
    textAnchor: { quote: 'The launch date is Friday.', attachmentState: 'attached' },
    allowedActions: ['reply', 'resolve'],
    author: { name: 'Reviewer', isMe: false },
    createdAt: '2026-09-09T00:00:00.000Z',
    modifiedAt: '2026-09-09T00:00:00.000Z',
    resolved: false,
    deleted: false,
    replies: [],
  }
}

test('an external thread is measured off its highlight, across every part of it', () => {
  const { window } = new JSDOM(`
    <div id="scroll">
      <mark data-plan-comment="local-1">local</mark>
      <span data-external-comment="ext-anchored">first half</span>
      <span data-external-comment="ext-anchored">second half</span>
    </div>
  `)
  const scroll = window.document.querySelector<HTMLElement>('#scroll')!
  scroll.getBoundingClientRect = () => new window.DOMRect(0, 0, 600, 800)
  scroll.querySelector<HTMLElement>('mark')!.getBoundingClientRect = () =>
    new window.DOMRect(0, 100, 120, 20)
  const parts = scroll.querySelectorAll<HTMLElement>('[data-external-comment]')
  parts[0].getBoundingClientRect = () => new window.DOMRect(0, 300, 200, 20)
  parts[1].getBoundingClientRect = () => new window.DOMRect(0, 320, 90, 20)

  const anchors = measureAnchors(
    scroll,
    [localComment('local-1')],
    ['ext-anchored', 'ext-unplaced'],
  )

  const external = anchors.find((anchor) => anchor.id === 'ext-anchored')!
  // The card sits on the run's opening line; the connector leaves its last one.
  expect(external.anchorTop).toBe(300)
  expect(external.anchorBottom).toBe(340)
  expect(external.anchorRight).toBe(90)
  expect(anchors.some((anchor) => anchor.id === 'local-1')).toBe(true)
  // A page-level, detached, or no-longer-present quote has nothing to measure.
  // That absence is what puts a thread in the Page view instead of the margin.
  expect(anchors.some((anchor) => anchor.id === 'ext-unplaced')).toBe(false)
})

test('a card the margin cannot fit is hidden and counted at its edge, not sliced by it', () => {
  // A short document whose threads all anchor near the top: the margin is not
  // tall enough for all of them. The ones that do not fit were packed on past
  // the bottom of the canvas, where the last was left half-drawn and the rest
  // ran off the end of the page with nothing to say they were there.
  const viewport = { top: 0, bottom: 700 }
  const crowded = Array.from({ length: 7 }, (_, index) => ({
    id: `thread-${index}`,
    anchorTop: 20 * index,
    height: 180,
  }))

  const layout = layoutThreads(crowded, { viewport })

  expect(layout.hidden.has('thread-0')).toBe(false)
  expect(layout.hidden.has('thread-6')).toBe(true)
  // Every hidden card is one the edge counter accounts for, and the counter
  // carries the nearest of them so pressing it goes somewhere.
  expect(layout.below).toBe(layout.hidden.size)
  expect(layout.nearestBelowId).toBe([...layout.hidden][0])

  // And it goes somewhere useful: the thread it opens wins its own line, so the
  // card the reader asked for is the one that comes back into view.
  const opened = layoutThreads(crowded, { viewport, focusedId: layout.nearestBelowId })
  expect(opened.hidden.has(layout.nearestBelowId!)).toBe(false)
})

test('local and external cards are placed in one collision pass, so neither is buried', () => {
  const merged = railThreads(
    [localComment('local-1')],
    [externalThread('ext-1')],
  )
  expect(merged.map((item) => `${item.kind}:${item.id}`)).toEqual([
    'local:local-1',
    'external:ext-1',
  ])

  // Both want the same line. One rail means one of them yields to the other
  // rather than the two overlapping in separate surfaces.
  const layout = layoutThreads(
    merged.map((item) => ({ id: item.id, anchorTop: 200, height: 90 })),
  )
  const tops = merged.map((item) => layout.tops.get(item.id)!)
  expect(tops[0]).toBe(198)
  expect(tops[1]).toBeGreaterThanOrEqual(tops[0] + 90)
})
