import type { HostPairing } from '@solus/contracts/host-pairing'
import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import { permissionsAllow } from '@solus/contracts/permissions'
import type { HostApi } from './host-api'
import type { HostEventSubscriber } from './host-event-subscriber'
import type { KnownHost } from './known-host'
import { answersAsSavedHost } from './host-link'
import { pairServer } from './pairing'

/**
 * Owner clients keep their own credentials for hosts added from chat or the CLI.
 * A client pairs a host its owner host paired when it holds no token for it, or when
 * the host refuses its token and the owner paired that host again after this token
 * came (`HostPairing.pairedAt`). So it pairs at most once for each owner pairing, and
 * a refusal or a failed pairing cannot start a loop: a failed owner pairing is tried
 * again only when the owner pairs that host again, or when the person chooses Pair
 * again (`pairAgain`).
 * Reads coalesce, failed reads remove nothing, and a disposed connection saves nothing.
 */
export class HostPairingFollower {
  private dirty = false
  private running: Promise<void> | null = null
  private disposed = false
  /** installationId → the `pairedAt` of the owner pairing that this device failed to follow. */
  private readonly failedPairings = new Map<string, number>()
  private readonly unsubscribe: () => void

  constructor(private readonly options: {
    api: Pick<HostApi, 'hostsListPaired' | 'hostsPairClient'>
    /** This host's server info, from the read the connection shares (`HostFacts`). */
    serverInfo(): Promise<Pick<ConnectionsServerInfo, 'principal' | 'permissions' | 'installationId'>>
    events: Pick<HostEventSubscriber, 'subscribe'>
    hosts(): readonly KnownHost[]
    save(host: KnownHost): Promise<{ listError: Error | null }>
    forget(hostId: string): Promise<void>
    /** The host refuses this device's token. */
    isRefused(hostId: string): boolean
    /** What this device calls itself, read when it pairs. */
    deviceLabel(): string
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
      this.report('Could not update paired hosts. Solus will try again when the connection changes.')
    }).finally(() => {
      this.running = null
      if (this.dirty && !this.disposed) void this.refresh()
    })
    return this.running
  }

  /** Pairs this device with a host that this host paired, now. False when this host is not its owner here or holds no pairing for it. */
  async pairAgain(installationId: string): Promise<boolean> {
    await this.running
    if (this.disposed) return false
    const self = await this.ownerInstallationId().catch(() => null)
    if (!self || self === installationId) return false
    const snapshot = await this.options.api.hostsListPaired().catch(() => null)
    const pairing = snapshot?.hosts.find(({ listing }) => listing.installationId === installationId)
    return !!pairing && !this.disposed && this.pair(pairing)
  }

  dispose(): void { this.disposed = true; this.unsubscribe() }

  private async read(): Promise<void> {
    this.dirty = false
    const self = await this.ownerInstallationId()
    if (!self) return
    const snapshot = await this.options.api.hostsListPaired()
    if (this.disposed) return
    for (const installationId of snapshot.forgotten) {
      const saved = this.savedHost(installationId)
      if (saved && installationId !== self) {
        try { await this.options.forget(saved.id) }
        catch { this.report(`Could not remove ${saved.label} from your host list. Other hosts can still pair.`) }
      }
      if (this.disposed) return
    }
    for (const pairing of snapshot.hosts) {
      if (this.disposed) return
      if (pairing.listing.installationId === self || this.failedPairings.get(pairing.listing.installationId) === pairing.pairedAt) continue
      if (this.needsPairing(pairing)) await this.pair(pairing)
    }
  }

  /** The installation id of this host when this client is its owner with local reach; null otherwise. */
  private async ownerInstallationId(): Promise<string | null> {
    const info = await this.options.serverInfo()
    return info.principal === 'local-owner' && permissionsAllow(info.permissions, 'host.local.reach') ? info.installationId : null
  }

  private savedHost(installationId: string): KnownHost | undefined {
    return this.options.hosts().find((host) => host.id === installationId)
  }

  private needsPairing({ listing, pairedAt }: HostPairing): boolean {
    const saved = this.savedHost(listing.installationId)
    if (!saved?.sessionToken) return true
    return this.options.isRefused(saved.id) && (saved.ownerPairedAt ?? 0) < pairedAt
  }

  private async pair({ listing, pairedAt }: HostPairing): Promise<boolean> {
    try {
      const credential = await this.options.api.hostsPairClient(listing.installationId)
      if (this.disposed) return false
      const fetchImpl: typeof fetch = (input, init) => (this.options.fetchImpl ?? fetch)(input, { ...init, redirect: 'error', signal: AbortSignal.timeout(5_000) })
      if (!await answersAsSavedHost(fetchImpl, { url: credential.url }, listing, AbortSignal.timeout(5_000))) throw new Error('The remote host did not prove its identity.')
      if (this.disposed) return false
      const replaced = this.savedHost(listing.installationId)?.sessionToken || undefined
      const paired = await pairServer({ url: credential.url, pairToken: credential.code, deviceLabel: this.options.deviceLabel(), serverLabel: listing.hasUserLabel ? listing.label : undefined, reportedName: listing.label, replacesSessionToken: replaced, fetchImpl })
      if (paired.installationId !== listing.installationId || paired.server.identityKey !== listing.identityKey) throw new Error('A different host answered the client pairing request.')
      if (this.disposed) return false
      // A remove while the HTTP request was in flight must not restore access.
      const current = await this.options.api.hostsListPaired()
      if (this.disposed || !current.hosts.some((host) => host.listing.installationId === listing.installationId)) return false
      const { listError } = await this.options.save({ ...paired.server, ownerPairedAt: pairedAt })
      this.failedPairings.delete(listing.installationId)
      if (listError) this.report(`${listing.label} is paired on this device, but its host list could not be saved. Solus will try again.`)
      return true
    } catch {
      this.failedPairings.set(listing.installationId, pairedAt)
      this.report(`Could not pair this device with ${listing.label}. Connect to its network and choose Pair again.`)
      return false
    }
  }

  private report(message: string): void {
    if (this.disposed) return
    if (this.options.onError) this.options.onError(message)
    else console.warn('[solus:pairing]', message)
  }
}
