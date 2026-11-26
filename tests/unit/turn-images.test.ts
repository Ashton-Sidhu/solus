import { expect, test } from 'bun:test'
import type { Message } from '@solus/contracts/types'
import { toolResultImages } from '@solus/client-core/reply-images'
import { galleryHrefs, hasGallerySlides, toolGroupViewedImages, toolRowImages } from '@solus/workspace-ui/components/conversation/lib/turn-images'
import { markdownAssetId } from '@solus/workspace-ui/components/conversation/lib/markdown-image'
import { snapshotHref } from '@solus/workspace-ui/components/browser/lib/snapshot-card'

test('the viewer can browse images across replies in one turn, in carousel order', () => {
  const messages: Message[] = [
    { id: 'before', role: 'assistant', content: '![Before](/tmp/before.png)', timestamp: 1 },
    { id: 'tool', role: 'tool', content: '![Hidden](/tmp/tool.png)', timestamp: 2 },
    { id: 'after', role: 'assistant', content: '![After](/tmp/after.png)', timestamp: 3 },
    { id: 'image', role: 'assistant', content: '', artifact: { kind: 'image', path: '/tmp/detail.png' }, timestamp: 4 },
  ]
  expect(galleryHrefs(messages)).toEqual(['/tmp/before.png', '/tmp/after.png', '/tmp/detail.png'])
})

test('one viewer steps through the images and the browser captures of a turn, in turn order', () => {
  // WHY: the gallery under a turn shows both kinds of picture side by side. If
  // the viewer only knew one kind, the arrows would skip the other and the strip
  // would open two different viewers.
  const capture = {
    browserPageId: 'browser_1',
    assetId: 'a'.repeat(64) + '.png',
    url: 'http://localhost:5173/',
    title: 'Solus',
    viewport: 'Desktop — 1440×900',
    appearance: 'light' as const,
    elementCount: 9,
    consoleErrors: 0,
    capturedAt: 1,
  }
  const messages: Message[] = [
    { id: 'before', role: 'assistant', content: '![Before](/tmp/before.png)', timestamp: 1 },
    { id: 'capture', role: 'assistant', content: '', browserSnapshot: capture, timestamp: 2 },
    { id: 'after', role: 'assistant', content: '![After](/tmp/after.png)', timestamp: 3 },
  ]
  const gallery = galleryHrefs(messages)
  expect(gallery).toEqual(['/tmp/before.png', snapshotHref(capture), '/tmp/after.png'])
  // The capture's path is an asset the host signs, so the viewer can load it.
  expect(markdownAssetId(gallery[1]!)).toBe(capture.assetId)
})

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
  // The image stays in the tool details.
  expect(hasGallerySlides([tool])).toBe(false)
})

test('tool groups preview successful workspace image reads once in read order', () => {
  const call = (toolName: string, path: string, toolStatus: Message['toolStatus'] = 'completed'): Message => ({
    id: path, role: 'tool', content: '', timestamp: 1, toolName, toolInput: JSON.stringify({ path }), toolStatus,
  })
  const tools = [
    call('Read', './docs/screen #1.png'),
    call('view_image', '/repo/docs/screen #1.png'),
    call('view_image', '/repo/second.jpg'),
    call('device_screenshot', 'device.png'),
    call('Read', 'missing.png', 'error'),
    call('Read', 'unfinished.png', 'running'),
    call('Read', 'docs/../outside/../../other.png'),
    call('Read', '/repository/outside.png'),
    call('Read', 'https://example.com/image.png'),
    call('Read', 'docs/page.md'),
  ]
  expect(toolGroupViewedImages(tools, '/repo')).toEqual(['/repo/docs/screen #1.png', '/repo/second.jpg'])
  expect(toolGroupViewedImages(tools, undefined)).toEqual([])
  expect(toolGroupViewedImages([call('view_image', 'c:/repo/Demo.png'), call('Read', 'demo.png')], 'C:\\repo'))
    .toEqual(['C:\\repo\\Demo.png'])
})
