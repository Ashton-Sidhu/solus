import { describe, expect, test } from 'bun:test'
import { stableImageCacheKey } from '../../apps/mobile/src/features/files/host-media-url'

describe('native mobile host image cache key', () => {
  test('names an asset by its host and asset id, so a new signed URL hits the cache', () => {
    // WHY: every mint signs a new URL. An asset never changes after the host
    // stores it, so its key must not depend on the URL token.
    const key = stableImageCacheKey('host-a', { assetId: 'snap-1' })
    expect(key).not.toBeNull()
    expect(key).toBe(stableImageCacheKey('host-a', { assetId: 'snap-1' }))
  })

  test('keeps assets of different hosts and different ids apart', () => {
    // WHY: two hosts can hold the same asset id with different bytes.
    const key = stableImageCacheKey('host-a', { assetId: 'snap-1' })
    expect(stableImageCacheKey('host-b', { assetId: 'snap-1' })).not.toBe(key)
    expect(stableImageCacheKey('host-a', { assetId: 'snap-2' })).not.toBe(key)
  })

  test('gives no stable key to a workspace path or GitHub media, whose content can change', () => {
    // WHY: a file in the project can be written again at the same path; a key
    // without the URL would show the old picture.
    expect(stableImageCacheKey('host-a', { path: '/repo/screenshot.png' })).toBeNull()
    expect(stableImageCacheKey('host-a', { githubMediaUrl: 'https://github.com/user-attachments/assets/x' })).toBeNull()
  })
})
