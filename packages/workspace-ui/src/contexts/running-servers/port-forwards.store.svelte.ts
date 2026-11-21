import { SvelteMap } from 'svelte/reactivity'
import type { NativeServerForward } from '@solus/contracts/running-servers'
import { localApi } from '@solus/client-core/local-api'
import { serverConnections } from '@solus/client-core/server-connections'

interface PortForward {
  hostId: string
  remotePort: number
  localPort: number
}

interface ActivePortForward {
  hostId: string
  remotePort: number
  native: NativeServerForward
  timer: ReturnType<typeof setTimeout>
  unwatch: () => void
  pending?: Promise<void>
  stopping?: Promise<void>
}

class PortForwardsStore {
  readonly #rows = new SvelteMap<string, PortForward>()
  readonly #active = new Map<string, ActivePortForward>()
  readonly #opening = new Map<string, Promise<void>>()

  get rows(): PortForward[] { return [...this.#rows.values()] }

  async start(hostId: string, remotePort: number): Promise<void> {
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      throw new Error('Enter a TCP port from 1 to 65535.')
    }
    const key = JSON.stringify(['port', hostId, remotePort])
    const active = this.#active.get(key)
    if (active?.stopping) await active.stopping
    if (this.#active.has(key)) return
    const opening = this.#opening.get(key)
    if (opening) return opening
    const start = this.#open(key, hostId, remotePort).finally(() => this.#opening.delete(key))
    this.#opening.set(key, start)
    return start
  }

  stop(hostId: string, remotePort: number): Promise<void> {
    const key = JSON.stringify(['port', hostId, remotePort])
    const entry = this.#active.get(key)
    if (!entry) return Promise.resolve()
    if (entry.stopping) return entry.stopping
    clearTimeout(entry.timer)
    entry.stopping = this.#stop(key, entry)
    return entry.stopping
  }

  async #open(key: string, hostId: string, remotePort: number): Promise<void> {
    const native = await this.#bind(key, hostId, remotePort)
    if (serverConnections.readinessFor(hostId).readiness !== 'ready') {
      await localApi.serverForwardStop(native.forwardId)
      throw new Error('The host disconnected before forwarding started.')
    }
    const timer = setTimeout(() => this.#renew(key), 30_000)
    const unwatch = serverConnections.onReadinessChange((changedHostId, readiness) => {
      if (changedHostId === hostId && readiness !== 'ready') {
        void this.stop(hostId, remotePort).catch(() => {})
      }
    })
    this.#active.set(key, { hostId, remotePort, native, timer, unwatch })
    this.#rows.set(key, { hostId, remotePort, localPort: native.localPort })
  }

  #renew(key: string): void {
    const entry = this.#active.get(key)
    if (!entry || entry.stopping) return
    entry.pending = this.#bind(key, entry.hostId, entry.remotePort).then((native) => {
      entry.native = native
      if (entry.stopping) return
      if (this.#rows.get(key)?.localPort !== native.localPort) {
        this.#rows.set(key, { hostId: entry.hostId, remotePort: entry.remotePort, localPort: native.localPort })
      }
      entry.timer = setTimeout(() => this.#renew(key), 30_000)
    }).catch(() => {
      if (!entry.stopping) {
        entry.unwatch()
        this.#active.delete(key)
        this.#rows.delete(key)
        void localApi.serverForwardStop(entry.native.forwardId).catch(() => {})
      }
    }).finally(() => { entry.pending = undefined })
  }

  async #stop(key: string, entry: ActivePortForward): Promise<void> {
    await entry.pending
    try {
      await localApi.serverForwardStop(entry.native.forwardId)
      entry.unwatch()
      this.#active.delete(key)
      this.#rows.delete(key)
    } catch (error) {
      entry.stopping = undefined
      entry.timer = setTimeout(() => this.#renew(key), 30_000)
      throw error
    }
  }

  async #bind(key: string, hostId: string, remotePort: number): Promise<NativeServerForward> {
    if (serverConnections.readinessFor(hostId).readiness !== 'ready') throw new Error('The host is disconnected.')
    const origin = serverConnections.httpOriginFor(hostId)
    const ticket = await serverConnections.apiFor(hostId).portForwardTunnel(remotePort)
    const tunnel = new URL(ticket.relativeUrl, origin)
    tunnel.protocol = tunnel.protocol === 'https:' ? 'wss:' : 'ws:'
    return localApi.serverForwardStart({
      endpointKey: key,
      tunnelUrl: tunnel.href,
      targetUrl: `http://127.0.0.1:${remotePort}/`,
      expiresAt: ticket.expiresAt,
    })
  }
}

export const portForwards = new PortForwardsStore()
