import { describe, expect, mock, test } from 'bun:test'
import type { HostConnection } from '../../apps/mobile/src/features/hosts/host-connections'
import { projectContext } from '../../apps/mobile/src/features/conversation/lib/ipc-context'
import { pullRequestMediaUrl } from '../../apps/mobile/src/features/prs/pull-request-media'

// A screenshot in a private pull request is a 404 without a GitHub credential.
// Only the host has one, so the phone loads that media through a URL the host
// signs; anything else, or a host that cannot sign, loads the address as is.

const ctx = projectContext('/work/app', null)
const UPLOAD = 'https://github.com/user-attachments/assets/abc-123'

function fakeConnection(hostId: string, options: { githubMediaUrls?: boolean; expiresIn?: number; refuse?: boolean; readiness?: string } = {}) {
  let minted = 0
  const prMediaUrl = mock(async () => {
    if (options.refuse) throw new Error('This host only collaborates.')
    return { relativeUrl: `/api/assets/github-${++minted}`, expiresAt: Date.now() + (options.expiresIn ?? 3_600_000) }
  })
  const connection = {
    hostId,
    state: { readiness: options.readiness ?? 'ready' },
    api: { prMediaUrl },
    transport: { serverUrl: 'https://host.example:4000/socket' },
    facts: { when: async () => ({ githubMediaUrls: options.githubMediaUrls ?? true }) },
  } as unknown as HostConnection
  return { connection, prMediaUrl }
}

describe('pull request media URLs', () => {
  test('GitHub media loads through a URL the host signs, absolute on the host origin, and is reused while fresh', async () => {
    const { connection, prMediaUrl } = fakeConnection('media-a')
    expect(await pullRequestMediaUrl(connection, UPLOAD, ctx)).toBe('https://host.example:4000/api/assets/github-1')
    expect(await pullRequestMediaUrl(connection, UPLOAD, ctx)).toBe('https://host.example:4000/api/assets/github-1')
    expect(prMediaUrl).toHaveBeenCalledTimes(1)
    expect(prMediaUrl.mock.calls[0]).toEqual([ctx, UPLOAD] as never)
  })

  test('a URL close to its expiry is signed again', async () => {
    const { connection, prMediaUrl } = fakeConnection('media-b', { expiresIn: 30_000 })
    await pullRequestMediaUrl(connection, UPLOAD, ctx)
    expect(await pullRequestMediaUrl(connection, UPLOAD, ctx)).toBe('https://host.example:4000/api/assets/github-2')
    expect(prMediaUrl).toHaveBeenCalledTimes(2)
  })

  test('the host signs the fetch URL: a blob page becomes the raw file', async () => {
    const { connection, prMediaUrl } = fakeConnection('media-c')
    await pullRequestMediaUrl(connection, 'https://github.com/o/r/blob/main/shot.png', ctx)
    expect(prMediaUrl.mock.calls[0]).toEqual([ctx, 'https://raw.githubusercontent.com/o/r/main/shot.png'] as never)
  })

  test('other media, a host without the capability, a refusal, or no connection load the direct URL', async () => {
    const other = fakeConnection('media-d')
    const selfSigned = 'https://private-user-images.githubusercontent.com/1/shot.png?jwt=x'
    expect(await pullRequestMediaUrl(other.connection, selfSigned, ctx)).toBe(selfSigned)
    expect(other.prMediaUrl).not.toHaveBeenCalled()

    const old = fakeConnection('media-e', { githubMediaUrls: false })
    expect(await pullRequestMediaUrl(old.connection, UPLOAD, ctx)).toBe(UPLOAD)
    expect(old.prMediaUrl).not.toHaveBeenCalled()

    const refusing = fakeConnection('media-f', { refuse: true })
    expect(await pullRequestMediaUrl(refusing.connection, UPLOAD, ctx)).toBe(UPLOAD)

    const offline = fakeConnection('media-g', { readiness: 'reconnecting' })
    expect(await pullRequestMediaUrl(offline.connection, UPLOAD, ctx)).toBe(UPLOAD)
    expect(await pullRequestMediaUrl(null, UPLOAD, ctx)).toBe(UPLOAD)
  })
})
