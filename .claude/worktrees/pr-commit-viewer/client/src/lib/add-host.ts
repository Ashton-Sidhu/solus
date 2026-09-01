import { claimServer, defaultDeviceLabel, normalizeServerUrl, pairServer, urlHost } from '@client-core/pairing'
import { loadServers, upsertServer, type SavedServer } from '@client-core/server-registry'
import { track } from '@renderer/lib/analytics'
import { classifyConnectInput, probeServer } from './connect'

/** A Solus server offered to the user without them having to name it. */
export interface OfferedHost {
  url: string
  /** The name the server reports, falling back to its address. */
  name: string
}

/**
 * Every Solus server serves this client, so the address already in the URL bar
 * is usually the host the user means — asking them to type it back in is a
 * strange thing to do. Returns null for an origin that is not a Solus server
 * (static hosting, the dev origin), and for one already saved under any
 * address: the same box reached by LAN IP and by Tailscale name is one host.
 */
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

export interface AddHostRequest {
  /** The smart field: a pairing link, or a bare address. */
  input: string
  /** The 6-digit code, required only when `input` is an address. */
  code?: string
  /** Friendly name for the host; falls back to the name it reports. */
  serverLabel?: string
}

/**
 * The one pairing path behind the smart connect field, shared by every surface
 * that offers it. A pasted link carries its own token; an address needs the
 * code, which a fresh host takes as a claim and an owned one as a pairing
 * token. Saves the host on success. Throws with a message meant for the user.
 */
export async function addHostFromInput({
  input,
  code = '',
  serverLabel = '',
}: AddHostRequest): Promise<SavedServer> {
  const classified = classifyConnectInput(input)
  if (classified.kind === 'empty') {
    throw new Error('Paste a pairing link or enter a server address')
  }
  const trimmedCode = code.trim()
  if (classified.kind === 'address' && !/^\d{6}$/.test(trimmedCode)) {
    throw new Error('Enter the 6-digit code from the server')
  }

  const deviceLabel = defaultDeviceLabel()
  const label = serverLabel.trim()
  let method: 'token' | 'claim' = classified.kind === 'link' ? 'token' : 'claim'
  try {
    let server: SavedServer
    if (classified.kind === 'link') {
      ({ server } = await pairServer({
        url: classified.url,
        pairToken: classified.pairToken,
        deviceLabel,
        serverLabel: label,
      }))
    } else {
      // A fresh, unclaimed server takes its code at /claim; an owned one
      // treats the same 6 digits as a pairing code.
      const health = await probeServer(classified.url)
      if (health.claimable) {
        ({ server } = await claimServer({
          url: classified.url,
          code: trimmedCode,
          deviceLabel,
          serverLabel: label || health.name,
        }))
      } else {
        method = 'token'
        ;({ server } = await pairServer({
          url: classified.url,
          pairToken: trimmedCode,
          deviceLabel,
          serverLabel: label || health.name,
        }))
      }
    }
    upsertServer(server)
    track('pairing_completed', { method })
    return server
  } catch (err) {
    track('pairing_failed', { method })
    throw err
  }
}
