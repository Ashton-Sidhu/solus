import { hostPolicy } from '@solus/client-core/host-policy'
import { serverConnections } from '@solus/client-core/server-connections'
import type { IpcContext } from '@solus/contracts/types'
import { assetUrlCache, localArtifactProtocolUrl } from '../components/artifact/lib/asset-url'

/** A file on a host that a client wants to show: a path or a stored asset. */
export interface HostMediaRequest {
  serverId: string
  /** Absolute path on the host. Exclusive with `assetId`. */
  path?: string
  /** Content-addressed asset id, the part after `asset://`. */
  assetId?: string
  /** Download name for an asset. */
  name?: string
  ctx?: IpcContext
  /** This client can read the host's disk itself: the desktop app with the host
   *  on the same machine. Every other client gets a signed URL. */
  canReadLocalFiles: boolean
  /** Mint a new signed URL even when the cached one has time left. */
  refresh?: boolean
}

/**
 * A URL this client can load for a host file or asset. A client never opens a
 * host path itself unless the host is this machine; otherwise the host signs a
 * short-lived URL, which `assetUrlCache` shares and renews.
 */
export async function resolveHostMediaUrl(request: HostMediaRequest): Promise<string> {
  if (request.path && request.canReadLocalFiles && hostPolicy.isClientMachine(request.serverId)) {
    return localArtifactProtocolUrl(request.path)
  }
  const capabilities = await serverConnections.capabilitiesFor(request.serverId)
  if (capabilities.assetUrls !== true) throw new Error('Update the host to show media from it.')
  return assetUrlCache.resolve({
    serverId: request.serverId,
    path: request.assetId ? undefined : request.path,
    assetId: request.assetId,
    name: request.name,
    origin: serverConnections.httpOriginFor(request.serverId),
    api: serverConnections.apiFor(request.serverId),
    ctx: request.ctx,
    refresh: request.refresh,
  })
}

/**
 * The URL for one host file, kept current while a component shows it. Create it
 * during component setup. `url` is null while it resolves and when it fails;
 * `retry` mints a fresh URL, which is what a player needs after the host
 * refuses an expired one.
 */
export class HostMediaUrl {
  url = $state<string | null>(null)
  hasFailed = $state(false)
  private generation = 0
  private readonly request: () => HostMediaRequest | null

  constructor(request: () => HostMediaRequest | null) {
    this.request = request
    $effect(() => {
      const current = request()
      void this.load(current, false)
    })
  }

  /** Resolve again with a new signed URL. Rejects when the host still cannot
   *  serve the file, so a player can stay in its error state. */
  async retry(): Promise<void> {
    await this.load(this.request(), true)
    if (this.hasFailed) throw new Error('The host cannot serve this file.')
  }

  private async load(request: HostMediaRequest | null, refresh: boolean): Promise<void> {
    const generation = ++this.generation
    this.url = null
    this.hasFailed = false
    if (!request || (!request.path && !request.assetId)) {
      return
    }
    try {
      const url = await resolveHostMediaUrl({ ...request, refresh })
      if (generation !== this.generation) return
      this.url = url
      this.hasFailed = false
    } catch {
      if (generation !== this.generation) return
      this.hasFailed = true
    }
  }
}
