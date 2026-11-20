import { normalizeServerUrl, pairServer, urlHost } from '@solus/client-core/pairing'
import { defaultDeviceLabel } from '@solus/client-core/device-label'
import type { KnownHost } from '@solus/client-core/known-host'
import { hostCatalog } from '@solus/client-core/host-catalog'
import { mergeRoutes, routeForUrl } from '@solus/contracts/host-routes'
import { track } from '@solus/workspace-ui/lib/analytics'
import { classifyConnectInput, probeServer, type ProbedServer } from './connect'

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
  entry: KnownHost | null
  /** The host as this browser knows it: paired here, or at this address; null when it knows none. */
  known: KnownHost | null
}

export async function probeServingOrigin(origin: string): Promise<ServingOrigin | null> {
  const health = await probeServer(origin)
  if (!health.ok) return null
  const normalizedOrigin = normalizeServerUrl(origin)
  // The page's host is dialed before the person's list is read there, so its credential alone names it.
  const known = (health.installationId ? hostCatalog.pairedHost(health.installationId) : null)
    ?? hostCatalog.hosts().find((server) => server.routes.some((route) => normalizeServerUrl(route.url) === normalizedOrigin))
  const name = health.name || urlHost(origin)
  const entry: KnownHost | null = health.requireAuth === false && health.installationId
    ? { id: health.installationId, routes: mergeRoutes([], [routeForUrl(origin)], 'page', Date.now()), sessionToken: '', installationId: health.installationId, label: health.name || 'This computer', os: health.os, lastConnected: Date.now() }
    : null
  return { offered: { url: origin, name }, entry, known: known ?? null }
}

/** Why a typed address gave no Solus host, from what the probe saw (docs/plans/tailscale-support.md D2). */
export function unreachableMessage(url: string, health: ProbedServer, pageProtocol: string): string {
  if (!health.unreachable) {
    return `A server answered at ${urlHost(url)}, but it is not a Solus host. Check the port shown in Settings → Hosts → Access on the host.`
  }
  // A browser hides a mixed-content block as a plain network error.
  if (health.unreachable === 'insecure-blocked' || (pageProtocol === 'https:' && url.startsWith('http://'))) {
    return `This page is served over https, so it cannot reach ${urlHost(url)} over plain http. Open Solus from the host's own address instead.`
  }
  if (health.unreachable === 'timeout') {
    return `${urlHost(url)} did not answer in time. Check that Tailscale or your Wi-Fi is on, on this device and on the host.`
  }
  if (health.unreachable === 'refused') {
    return `Nothing listens at ${urlHost(url)}. Check the port; a Solus host often uses 3000.`
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

/** Pairs this browser with the host the input names. The caller keeps the host (`hostCatalog.pair`). */
export async function addHostFromInput({
  input,
  code = '',
  serverLabel = '',
  deviceLabel = defaultDeviceLabel(),
}: AddHostRequest): Promise<KnownHost> {
  const classified = classifyConnectInput(input)
  if (classified.kind === 'empty') {
    throw new Error('Paste a pairing link or enter a server address')
  }
  const trimmedCode = code.trim()

  const label = serverLabel.trim()
  const method = 'token'
  try {
    let server: KnownHost
    if (classified.kind === 'link') {
      ({ server } = await pairServer({
        url: classified.url,
        pairToken: classified.pairToken,
        deviceLabel: deviceLabel.trim() || defaultDeviceLabel(),
        serverLabel: label,
      }))
    } else {
      const health = await probeServer(classified.url)
      if (!health.ok) throw new Error(unreachableMessage(classified.url, health, location.protocol))
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
    track('pairing_completed', { method })
    return server
  } catch (err) {
    track('pairing_failed', { method })
    throw err
  }
}
