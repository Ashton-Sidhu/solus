import type { HostListing } from '@solus/contracts/host-list'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import { permissionsAllow } from '@solus/contracts/permissions'
import type { HostApi } from './host-api'
import type { HostEventSubscriber } from './host-event-subscriber'
import type { KnownHost } from './known-host'
import { answersAsSavedHost } from './host-link'
import { pairServer } from './pairing'

/** Owner clients keep their own credentials for hosts added from chat or the CLI.
 * Reads coalesce, failed reads remove nothing, and a disposed connection saves nothing. */
export class HostPairingFollower {
  private dirty = false
  private running: Promise<void> | null = null
  private disposed = false
  private readonly unsubscribe: () => void

  constructor(private readonly options: {
    api: Pick<HostApi, 'hostsListPaired' | 'hostsPairClient'> & { connectionsGetServerInfo(): Promise<Pick<ConnectionsServerInfo, 'principal' | 'permissions' | 'installationId'>> }
    events: Pick<HostEventSubscriber, 'subscribe'>
    hosts(): readonly KnownHost[]
    save(host: KnownHost): Promise<void>
    forget(hostId: string): Promise<void>
    deviceLabel: string
    onError?(message: string): void
    fetchImpl?: typeof fetch
  }) {
    this.unsubscribe = options.events.subscribe('host.listChanged', () => this.refresh())
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.dirty = true
    if (this.running) return this.running
    this.running = this.read().catch(() => {
      // An older host has no pairing snapshot. Its existing connections stay available.
    }).finally(() => {
      this.running = null
      if (this.dirty && !this.disposed) void this.refresh()
    })
    return this.running
  }

  dispose(): void { this.disposed = true; this.unsubscribe() }

  private async read(): Promise<void> {
    this.dirty = false
    const info = await this.options.api.connectionsGetServerInfo()
    if (info.principal !== 'local-owner' || !permissionsAllow(info.permissions, 'host.local.reach')) return
    const snapshot = await this.options.api.hostsListPaired()
    if (this.disposed) return
    for (const installationId of snapshot.forgotten) {
      const saved = this.options.hosts().find((host) => host.installationId === installationId)
      if (saved && installationId !== info.installationId) await this.options.forget(saved.id)
      if (this.disposed) return
    }
    for (const listing of snapshot.hosts) {
      if (this.disposed) return
      if (listing.installationId === info.installationId || this.options.hosts().some((host) => host.installationId === listing.installationId && host.sessionToken)) continue
      await this.pair(listing)
    }
  }

  private async pair(listing: HostListing): Promise<void> {
    try {
      const credential = await this.options.api.hostsPairClient(listing.installationId)
      if (this.disposed) return
      const fetchImpl: typeof fetch = (input, init) => (this.options.fetchImpl ?? fetch)(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(5_000) })
      if (!await answersAsSavedHost(fetchImpl, { url: credential.url }, listing, AbortSignal.timeout(5_000))) throw new Error('The remote host did not prove its identity.')
      if (this.disposed) return
      const paired = await pairServer({ url: credential.url, pairToken: credential.code, deviceLabel: this.options.deviceLabel, serverLabel: listing.hasUserLabel ? listing.label : undefined, reportedName: listing.label, fetchImpl })
      if (paired.installationId !== listing.installationId || paired.server.identityKey !== listing.identityKey) throw new Error('A different host answered the client pairing request.')
      if (this.disposed) return
      // A remove while the HTTP request was in flight must not restore access.
      const current = await this.options.api.hostsListPaired()
      if (this.disposed || !current.hosts.some((host) => host.installationId === listing.installationId)) return
      await this.options.save(paired.server)
    } catch {
      this.options.onError?.(`Could not pair this device with ${listing.label}. Connect to its network and try again.`)
    }
  }
}
