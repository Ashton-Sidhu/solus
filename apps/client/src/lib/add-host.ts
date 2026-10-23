import { normalizeServerUrl, pairServer, urlHost } from '@solus/client-core/pairing'
import { defaultDeviceLabel } from '@solus/client-core/device-label'
import { loadServers, upsertServer, type SavedServer } from '@solus/client-core/server-registry'
import { track } from '@solus/workspace-ui/lib/analytics'
import { classifyConnectInput, probeServer } from './connect'

/** A Solus server offered to the user without them having to name it. */
export interface OfferedHost {
  url: string
  /** The name the server reports, falling back to its address. */
  name: string
}

/** The Solus host serving this page, as one `/health` read tells it. */
export interface ServingOrigin {
  /** What to offer the user when this browser does not keep the host yet. */
  offered: OfferedHost
  /** The host's entry when it admits this browser with no pairing (loopback, a proxied bind). */
  entry: SavedServer | null
  /** This browser already keeps the host. */
  isSaved: boolean
}

export async function probeServingOrigin(origin: string): Promise<ServingOrigin | null> {
  const health = await probeServer(origin)
  if (!health.ok) return null
  const normalizedOrigin = normalizeServerUrl(origin)
  const isSaved = loadServers().some((server) =>
    (!!health.installationId && server.installationId === health.installationId)
    || normalizeServerUrl(server.url) === normalizedOrigin,
  )
  const name = health.name || urlHost(origin)
  const entry: SavedServer | null = health.requireAuth === false && health.installationId
    ? { id: health.installationId, url: origin, sessionToken: '', installationId: health.installationId, label: health.name || 'This computer', os: health.os, lastConnected: Date.now() }
    : null
  return { offered: { url: origin, name }, entry, isSaved }
}

function unreachableMessage(url: string): string {
  if (location.protocol === 'https:' && url.startsWith('http://')) {
    return `This page is served over https, so it cannot reach ${urlHost(url)} over plain http. Open Solus from the host's own address instead.`
  }
  return `No Solus server answered at ${urlHost(url)}. Check the address and port shown in Settings → Hosts → Access on the host.`
}

export interface AddHostRequest {
  /** The smart field: a pairing link, or a bare address. */
  input: string
  /** The 6-digit code, required only when `input` is an address the host
   *  does not trust this device at. */
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
      // A host that trusts this device by network position pairs without a code.
      const trusted = health.requireAuth === false
      if (!trusted && !/^\d{6}$/.test(trimmedCode)) {
        throw new Error('Enter the 6-digit code from the server')
      }
      const result = await pairServer({
        url: classified.url,
        pairToken: trusted && !trimmedCode ? undefined : trimmedCode,
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
