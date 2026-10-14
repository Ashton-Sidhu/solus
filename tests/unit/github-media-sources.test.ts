import { describe, expect, test } from 'bun:test'
import type { AssetCreateUrlResult } from '@solus/contracts/rpc'
import {
  GITHUB_MEDIA_REFRESH_WINDOW_MS,
  GithubMediaSources,
  type GithubMediaSigner,
} from '@solus/workspace-ui/components/github-markdown/lib/github-media.svelte'

// A private repository's screenshot shows only through the host's signed URL.
// The client must sign exactly the URLs the host agrees to, open the signature
// on the host's own origin, keep it until shortly before it expires, and fall
// back to the author's URL whenever the host cannot sign it.

const ATTACHMENT = 'https://github.com/user-attachments/assets/0f1e2d3c-aaaa-bbbb-cccc-123456789abc'
const ELSEWHERE = 'https://example.com/screenshot.png'

interface FakeHost {
  signs: boolean
  failMint: boolean
  mints: string[]
  expiresAt: number
}

function sourcesFor(host: FakeHost, clock: { now: number }) {
  const signer: GithubMediaSigner = {
    signs: async () => host.signs,
    mint: async (_serverId, url): Promise<AssetCreateUrlResult> => {
      host.mints.push(url)
      if (host.failMint) throw new Error('This host does not run agents.')
      return { relativeUrl: `/api/assets/payload-${host.mints.length}.hmac`, expiresAt: host.expiresAt }
    },
    origin: () => 'https://host.example:4100',
  }
  return new GithubMediaSources(signer, () => clock.now)
}

/** Let the mint's promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('signed GitHub media', () => {
  test('signs a GitHub attachment and opens it on the host origin', async () => {
    const host: FakeHost = { signs: true, failMint: false, mints: [], expiresAt: 3_600_000 }
    const clock = { now: 0 }
    const sources = sourcesFor(host, clock)
    sources.request('host-a', ATTACHMENT)
    // Nothing to draw while the first signature is on its way.
    expect(sources.sourceFor('host-a', ATTACHMENT)).toBeNull()
    await settle()
    expect(sources.sourceFor('host-a', ATTACHMENT)).toBe('https://host.example:4100/api/assets/payload-1.hmac')
    expect(host.mints).toEqual([ATTACHMENT])
  })

  test('keeps one signature until shortly before it expires, then signs again', async () => {
    const host: FakeHost = { signs: true, failMint: false, mints: [], expiresAt: 3_600_000 }
    const clock = { now: 0 }
    const sources = sourcesFor(host, clock)
    sources.request('host-a', ATTACHMENT)
    sources.request('host-a', ATTACHMENT)
    await settle()
    clock.now = 3_600_000 - GITHUB_MEDIA_REFRESH_WINDOW_MS - 1
    sources.request('host-a', ATTACHMENT)
    expect(host.mints).toHaveLength(1)

    clock.now = 3_600_000 - GITHUB_MEDIA_REFRESH_WINDOW_MS + 1
    host.expiresAt = 7_200_000
    sources.request('host-a', ATTACHMENT)
    // The old URL is still valid while the new one is minted.
    expect(sources.sourceFor('host-a', ATTACHMENT)).toBe('https://host.example:4100/api/assets/payload-1.hmac')
    await settle()
    expect(host.mints).toHaveLength(2)
    expect(sources.sourceFor('host-a', ATTACHMENT)).toBe('https://host.example:4100/api/assets/payload-2.hmac')
  })

  test('an expired signature is never drawn', async () => {
    const host: FakeHost = { signs: true, failMint: false, mints: [], expiresAt: 1_000 }
    const clock = { now: 0 }
    const sources = sourcesFor(host, clock)
    sources.request('host-a', ATTACHMENT)
    await settle()
    clock.now = 1_000
    expect(sources.sourceFor('host-a', ATTACHMENT)).toBeNull()
  })

  test('a host without the capability, or one that refuses, shows the author URL', async () => {
    const clock = { now: 0 }
    const old: FakeHost = { signs: false, failMint: false, mints: [], expiresAt: 3_600_000 }
    const oldSources = sourcesFor(old, clock)
    oldSources.request('host-a', ATTACHMENT)
    await settle()
    expect(oldSources.sourceFor('host-a', ATTACHMENT)).toBe(ATTACHMENT)
    expect(old.mints).toHaveLength(0)

    const collaborationOnly: FakeHost = { signs: true, failMint: true, mints: [], expiresAt: 3_600_000 }
    const refusing = sourcesFor(collaborationOnly, clock)
    refusing.request('host-a', ATTACHMENT)
    await settle()
    expect(refusing.sourceFor('host-a', ATTACHMENT)).toBe(ATTACHMENT)
    // A refusal is remembered, not asked again for every render.
    refusing.request('host-a', ATTACHMENT)
    expect(collaborationOnly.mints).toHaveLength(1)
  })

  test('media the host does not sign is never sent to it', async () => {
    const host: FakeHost = { signs: true, failMint: false, mints: [], expiresAt: 3_600_000 }
    const sources = sourcesFor(host, { now: 0 })
    sources.request('host-a', ELSEWHERE)
    await settle()
    expect(host.mints).toHaveLength(0)
    expect(sources.sourceFor('host-a', ELSEWHERE)).toBe(ELSEWHERE)
  })

  test('a signed URL that fails to load falls back to the author URL', async () => {
    const host: FakeHost = { signs: true, failMint: false, mints: [], expiresAt: 3_600_000 }
    const sources = sourcesFor(host, { now: 0 })
    sources.request('host-a', ATTACHMENT)
    await settle()
    sources.refuse('host-a', ATTACHMENT)
    expect(sources.sourceFor('host-a', ATTACHMENT)).toBe(ATTACHMENT)
  })

  test('each host signs its own copy', async () => {
    const host: FakeHost = { signs: true, failMint: false, mints: [], expiresAt: 3_600_000 }
    const sources = sourcesFor(host, { now: 0 })
    sources.request('host-a', ATTACHMENT)
    sources.request('host-b', ATTACHMENT)
    await settle()
    expect(host.mints).toHaveLength(2)
  })
})
