import { describe, expect, mock, test } from 'bun:test'
import type { HostConnection } from '../../apps/mobile/src/features/hosts/host-connections'
import { resolveHostMediaUrl } from '../../apps/mobile/src/features/files/host-media-url'

function fakeConnection(hostId: string, options: { assetUrls?: boolean; expiresIn?: number } = {}) {
  let minted = 0
  const assetCreateUrl = mock(async () => ({ relativeUrl: `/api/assets/token-${++minted}`, expiresAt: Date.now() + (options.expiresIn ?? 600_000) }))
  const connection = {
    hostId,
    api: { assetCreateUrl },
    transport: { serverUrl: 'https://host.example:4000/socket' },
    supervisor: { whenCapabilities: async () => ({ assetUrls: options.assetUrls ?? true }) },
  } as unknown as HostConnection
  return { connection, assetCreateUrl }
}

describe('native host media URLs', () => {
  test('signs a host path on the host origin and reuses it while it is fresh', async () => {
    // WHY: a remote host's path is not a phone path; the phone loads the bytes
    // only through a URL the host signs on its own origin.
    const { connection, assetCreateUrl } = fakeConnection('host-a')
    const first = await resolveHostMediaUrl(connection, { path: '/repo/shot.png' })
    expect(first).toBe('https://host.example:4000/api/assets/token-1')
    expect(await resolveHostMediaUrl(connection, { path: '/repo/shot.png' })).toBe(first)
    expect(assetCreateUrl).toHaveBeenCalledTimes(1)
  })

  test('mints again when asked to refresh or when the URL is about to expire', async () => {
    const { connection, assetCreateUrl } = fakeConnection('host-b', { expiresIn: 30_000 })
    await resolveHostMediaUrl(connection, { path: '/repo/clip.mp4' })
    await resolveHostMediaUrl(connection, { path: '/repo/clip.mp4' })
    expect(assetCreateUrl).toHaveBeenCalledTimes(2)
    const fresh = fakeConnection('host-c')
    await resolveHostMediaUrl(fresh.connection, { path: '/repo/clip.mp4' })
    await resolveHostMediaUrl(fresh.connection, { path: '/repo/clip.mp4' }, true)
    expect(fresh.assetCreateUrl).toHaveBeenCalledTimes(2)
  })

  test('a host without signed asset URLs says to update it', async () => {
    const { connection, assetCreateUrl } = fakeConnection('host-d', { assetUrls: false })
    await expect(resolveHostMediaUrl(connection, { path: '/repo/shot.png' })).rejects.toThrow('Update the host')
    expect(assetCreateUrl).not.toHaveBeenCalled()
  })
})
