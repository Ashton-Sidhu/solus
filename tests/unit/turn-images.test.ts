import { expect, test } from 'bun:test'
import type { Message } from '@solus/contracts/types'
import { hasGallerySlides } from '@solus/workspace-ui/components/conversation/lib/turn-images'

test('a turn mounts its image carousel only when it has an image to show', () => {
  // WHY: an empty carousel still measured itself as the transcript mounted,
  // and every turn has assistant replies, so each open laid the whole
  // transcript out once more per turn (docs/plans/session-open-performance.md).
  const reply = (content: string): Message => ({ id: content, role: 'assistant', content, timestamp: 1 })
  expect(hasGallerySlides([reply('The fix is in the reducer.'), reply('Done.')])).toBe(false)
  expect(hasGallerySlides([reply('Before:\n\n![chart](/tmp/chart.png)')])).toBe(true)
  expect(hasGallerySlides([{ ...reply(''), artifact: { kind: 'image', path: '/tmp/shot.png' } }])).toBe(true)
  // A tool row's text never becomes a slide.
  expect(hasGallerySlides([{ ...reply('![x](/tmp/x.png)'), role: 'tool' }])).toBe(false)
})
