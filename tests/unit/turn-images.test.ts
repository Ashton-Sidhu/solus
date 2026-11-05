import { expect, test } from 'bun:test'
import type { Message } from '@solus/contracts/types'
import { toolResultImages } from '@solus/client-core/reply-images'
import { hasGallerySlides, toolRowImages } from '@solus/workspace-ui/components/conversation/lib/turn-images'
import { markdownAssetId } from '@solus/workspace-ui/components/conversation/lib/markdown-image'

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

test('a tool row shows its images as asset references the host signs, and only when finished', () => {
  // WHY: the renderer may be on another device, so a tool image must load by
  // asset id and never by a host path. A call still running decodes nothing.
  const assetId = `${'a'.repeat(64)}.png`
  const tool: Message = {
    id: 't', role: 'tool', content: '', timestamp: 1, toolStatus: 'completed',
    toolImages: [{ assetId, mimeType: 'image/png', width: 10, height: 10 }, { assetId, mimeType: 'image/png' }, { assetId: `${'b'.repeat(64)}.jpg`, mimeType: 'image/jpeg' }],
  }
  const images = toolRowImages(tool)
  // The same picture twice is one image: a keyed list cannot hold it twice.
  expect(images.map((image) => image.format)).toEqual(['PNG', 'JPEG'])
  expect(images.map((image) => image.label)).toEqual(['Tool image 1', 'Tool image 2'])
  expect(markdownAssetId(images[0].href)).toBe(assetId)
  expect(toolRowImages({ ...tool, toolStatus: 'running' })).toEqual([])
  expect(toolResultImages(undefined)).toEqual([])
  // Tool images stay in the tool row, out of the turn's gallery.
  expect(hasGallerySlides([tool])).toBe(false)
})
