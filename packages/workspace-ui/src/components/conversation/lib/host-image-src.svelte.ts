import { SvelteMap } from 'svelte/reactivity'
import { hostKey } from '@solus/client-core/host-key'
import type { HostApi } from '@solus/client-core/host-api'
import type { IpcContext } from '@solus/contracts/types'
import { assetUrlCache } from '../../artifact/lib/asset-url'

export interface HostImageRequest {
  hostPath: string
  serverId: string
  origin: string
  api: Pick<HostApi, 'assetCreateUrl'>
  ctx?: IpcContext
}

export type HostImageState =
  | { status: 'pending' }
  | { status: 'ready'; url: string }
  | { status: 'failed' }

/**
 * Signed URLs for message images the run host stores. A prompt carries a path,
 * not its bytes, so a client that did not compose the message resolves the
 * picture here — once per host and path, however many bubbles show it.
 */
class HostImageSources {
  private readonly states = new SvelteMap<string, HostImageState>()

  stateFor(serverId: string, hostPath: string): HostImageState {
    return this.states.get(hostKey(serverId, hostPath)) ?? { status: 'pending' }
  }

  request(request: HostImageRequest): void {
    const key = hostKey(request.serverId, request.hostPath)
    if (this.states.has(key)) return
    this.states.set(key, { status: 'pending' })
    void assetUrlCache
      .resolve({
        serverId: request.serverId,
        path: request.hostPath,
        origin: request.origin,
        api: request.api,
        ctx: request.ctx,
      })
      .then((url) => this.states.set(key, { status: 'ready', url }))
      // The host may have dropped the file, or be too old to serve it. The
      // bubble states that rather than holding an empty frame forever.
      .catch(() => this.states.set(key, { status: 'failed' }))
  }
}

export const hostImageSources = new HostImageSources()
