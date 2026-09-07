import { defaultDeviceLabel, normalizeServerUrl, pairServer, urlHost } from '@solus/client-core/pairing'
import { loadServers, upsertServer, type SavedServer } from '@solus/client-core/server-registry'
import { track } from '@solus/workspace-ui/lib/analytics'
import { classifyConnectInput, probeServer } from './connect'

/** A Solus server offered to the user without them having to name it. */
export interface OfferedHost {
  url: string
  /** The name the server reports, falling back to its address. */
  name: string
}

export async function probeServingOrigin(origin: string): Promise<OfferedHost | null> {
  const health = await probeServer(origin)
  if (!health.ok) return null

  const normalizedOrigin = normalizeServerUrl(origin)
  const alreadySaved = loadServers().some((server) =>
    (!!health.installationId && server.installationId === health.installationId)
    || normalizeServerUrl(server.url) === normalizedOrigin,
  )
  if (alreadySaved) return null

  return { url: origin, name: health.name || urlHost(origin) }
}

function unreachableMessage(url: string): string {
  if (location.protocol === 'https:' && url.startsWith('http://')) {
    return `This page is served over https, so it cannot reach ${urlHost(url)} over plain http. Open Solus from the host's own address instead.`
  }
  return `No Solus server answered at ${urlHost(url)}. Check the address and port shown in Settings → Connections on the host.`
}

export interface AddHostRequest {
  /** The smart field: a pairing link, or a bare address. */
  input: string
  /** The 6-digit code, required only when `input` is an address. */
  code?: string
  /** Friendly name for the host; falls back to the name it reports. */
  serverLabel?: string
  deviceLabel?: string
}

export async function addHostFromInput({
  input,
  code = '',
  serverLabel = '',
  deviceLabel = defaultDeviceLabel(),
}: AddHostRequest): Promise<SavedServer> {
  const classified = classifyConnectInput(input)
  if (classified.kind === 'empty') {
    throw new Error('Paste a pairing link or enter a server address')
  }
  const trimmedCode = code.trim()
  if (classified.kind === 'address' && !/^\d{6}$/.test(trimmedCode)) {
    throw new Error('Enter the 6-digit code from the server')
  }

  const label = serverLabel.trim()
  const method = 'token'
  try {
    let server: SavedServer
    if (classified.kind === 'link') {
      ({ server } = await pairServer({
        url: classified.url,
        pairToken: classified.pairToken,
        deviceLabel: deviceLabel.trim() || defaultDeviceLabel(),
        serverLabel: label,
      }))
    } else {
      const health = await probeServer(classified.url)
      if (!health.ok) throw new Error(unreachableMessage(classified.url))
      const result = await pairServer({
        url: classified.url,
        pairToken: trimmedCode,
        deviceLabel: deviceLabel.trim() || defaultDeviceLabel(),
        serverLabel: label,
        reportedName: health.name,
      })
      server = result.server
    }
    upsertServer(server)
    track('pairing_completed', { method })
    return server
  } catch (err) {
    track('pairing_failed', { method })
    throw err
  }
}
