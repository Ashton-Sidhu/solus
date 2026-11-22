import type { HostApi } from '@solus/client-core/host-api'
import type { ConnectionsServerInfo, PairedDevice } from '@solus/contracts/host-api'
import type { HostOrganizationsStatus } from '@solus/contracts/organization-scope'
import { Listeners } from '../../lib/listeners'
import { relativeTime } from '../../lib/time'
import type { HostConnection } from '../hosts/host-connections'

/**
 * How one host is reached and who reaches it, as the desktop and web Access tab
 * shows it: its network, the pairing code it hands out, the devices with access,
 * its organizations. Only the host's local owner (the desktop on the machine
 * or a paired device, this phone included) changes how it is reached; the host
 * refuses anyone else, so the screen offers those controls to a local owner only.
 * The Solus Cloud link is `HostCloudLink`.
 */

export type HostEndpoint = Awaited<ReturnType<HostApi['connectionsListEndpoints']>>[number]
export type HostDevice = Awaited<ReturnType<HostApi['connectionsListSessions']>>[number]
export type HostPairCode = Awaited<ReturnType<HostApi['connectionsGeneratePairToken']>>

/** The one change in flight, so its control shows progress and the others wait. */
export type HostAccessAction = 'remote-access' | 'trust-local-network' | 'tailscale-serve' | 'pair' | `revoke:${string}` | `insights:${string}`

export interface HostAccessSnapshot {
  info: ConnectionsServerInfo
  endpoints: HostEndpoint[]
  devices: HostDevice[]
  /** The devices this host paired, connected or not. Only the host's owner may read them. */
  pairedDevices: PairedDevice[]
  /** Why the paired devices could not be read; the rest of the screen still shows. */
  pairedDevicesError: string | null
  organizations: HostOrganizationsStatus | null
  /** Why the organizations could not be read; the rest of the screen still shows. */
  organizationsError: string | null
  pair: HostPairCode | null
  busy: HostAccessAction | null
}

export type HostAccessState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | ({ kind: 'loaded' } & HostAccessSnapshot)
  | { kind: 'error'; message: string }

const IDLE = { kind: 'idle' } as const

export class HostAccess {
  readonly changes = new Listeners()
  private readonly states = new Map<string, HostAccessState>()
  /** One `host.organizationsChanged` subscription per host connection. */
  private readonly watches = new Map<string, { connection: HostConnection; stop: () => void }>()

  constructor(private readonly connectionFor: (hostId: string) => HostConnection | null) {}

  stateOf = (hostId: string): HostAccessState => this.states.get(hostId) ?? IDLE

  async load(hostId: string): Promise<void> {
    const connection = this.connectionFor(hostId)
    if (!connection) {
      this.set(hostId, { kind: 'error', message: 'This host cannot be reached now.' })
      return
    }
    this.watch(hostId, connection)
    const current = this.stateOf(hostId)
    if (current.kind !== 'loaded') this.set(hostId, { kind: 'loading' })
    try {
      const [info, endpoints, devices, paired, organizations] = await Promise.all([
        connection.api.connectionsGetServerInfo(),
        connection.api.connectionsListEndpoints(),
        connection.api.connectionsListSessions(),
        readPairedDevices(connection.api),
        readOrganizations(connection.api),
      ])
      if (this.connectionFor(hostId) !== connection) return
      const latest = this.stateOf(hostId)
      this.set(hostId, {
        kind: 'loaded',
        info,
        endpoints,
        devices,
        pairedDevices: paired.devices,
        pairedDevicesError: paired.error,
        organizations: organizations.status,
        organizationsError: organizations.error,
        // A code handed out before the reload stays on screen until it expires.
        pair: latest.kind === 'loaded' ? latest.pair : null,
        busy: latest.kind === 'loaded' ? latest.busy : null,
      })
    } catch (error) {
      if (this.connectionFor(hostId) !== connection) return
      this.set(hostId, { kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async setRemoteAccess(hostId: string, remoteAccess: import('@solus/contracts/host-api').RemoteAccessMode): Promise<void> {
    await this.change(hostId, 'remote-access', async (api, snapshot) => {
      const answer = await api.connectionsSetRemoteAccess({ remoteAccess })
      return { info: { ...snapshot.info, ...answer }, endpoints: await api.connectionsListEndpoints() }
    })
  }

  async setTrustLocalNetwork(hostId: string, trustLocalNetwork: boolean): Promise<void> {
    await this.change(hostId, 'trust-local-network', async (api, snapshot) => {
      const answer = await api.connectionsSetTrustLocalNetwork({ trustLocalNetwork })
      return { info: { ...snapshot.info, trustLocalNetwork: answer.trustLocalNetwork } }
    })
  }

  async setTailscaleServe(hostId: string, enabled: boolean, port: number): Promise<void> {
    await this.change(hostId, 'tailscale-serve', async (api) => {
      enabled
        ? await api.connectionsEnableTailscaleServe({ port })
        : await api.connectionsDisableTailscaleServe()
      return { info: await api.connectionsGetServerInfo() }
    })
  }

  async generatePairCode(hostId: string): Promise<void> {
    await this.change(hostId, 'pair', async (api) => ({ pair: await api.connectionsGeneratePairToken() }))
  }

  async revokeDevice(hostId: string, deviceId: string): Promise<void> {
    await this.change(hostId, `revoke:${deviceId}`, async (api) => {
      await api.connectionsRevokeDevice({ deviceId })
      const [devices, paired] = await Promise.all([api.connectionsListSessions(), readPairedDevices(api)])
      return { devices, pairedDevices: paired.devices, pairedDevicesError: paired.error }
    })
  }

  /** Opts this host's work for one organization into its Insights while the organization's policy is off. */
  async setInsightsOptIn(hostId: string, organizationId: string, enabled: boolean): Promise<void> {
    await this.change(hostId, `insights:${organizationId}`, async (api) => ({
      organizations: await api.hostSetInsightsOptIn(organizationId, enabled),
    }))
  }

  forgetHost(hostId: string): void {
    this.watches.get(hostId)?.stop()
    this.watches.delete(hostId)
    this.states.delete(hostId)
    this.changes.notify()
  }

  /** Runs one change and keeps the host's answer. Throws what the host refused; nothing on screen changes then. */
  private async change(
    hostId: string,
    action: HostAccessAction,
    run: (api: HostApi, snapshot: HostAccessSnapshot) => Promise<Partial<HostAccessSnapshot>>,
  ): Promise<void> {
    const connection = this.connectionFor(hostId)
    const current = this.stateOf(hostId)
    if (!connection || current.kind !== 'loaded') throw new Error('This host cannot be reached now.')
    if (current.busy) return
    this.set(hostId, { ...current, busy: action })
    try {
      const answer = await run(connection.api, current)
      const latest = this.stateOf(hostId)
      if (latest.kind === 'loaded') this.set(hostId, { ...latest, ...answer, busy: null })
    } catch (error) {
      const latest = this.stateOf(hostId)
      if (latest.kind === 'loaded') this.set(hostId, { ...latest, busy: null })
      throw error
    }
  }

  private watch(hostId: string, connection: HostConnection): void {
    const existing = this.watches.get(hostId)
    if (existing?.connection === connection) return
    existing?.stop()
    const stopOrganizations = connection.events.subscribe('host.organizationsChanged', (status) => {
      const current = this.stateOf(hostId)
      if (current.kind === 'loaded') this.set(hostId, { ...current, organizations: status, organizationsError: null })
    })
    const stopServe = connection.events.subscribe('host.tailscaleServeChanged', (status) => {
      const current = this.stateOf(hostId)
      if (current.kind === 'loaded') this.set(hostId, { ...current, info: { ...current.info, tailscaleServe: status } })
      void this.load(hostId)
    })
    this.watches.set(hostId, { connection, stop: () => { stopOrganizations(); stopServe() } })
  }

  private set(hostId: string, state: HostAccessState): void {
    this.states.set(hostId, state)
    this.changes.notify()
  }
}

/** A host that refuses its paired devices (to anyone but its owner) says why; the rest of the screen still shows. */
async function readPairedDevices(api: HostApi): Promise<{ devices: PairedDevice[]; error: string | null }> {
  try {
    return { devices: await api.connectionsListDevices(), error: null }
  } catch (error) {
    return { devices: [], error: error instanceof Error ? error.message : String(error) }
  }
}

/** A host that cannot read its organizations says why; the rest of the screen still shows. */
async function readOrganizations(api: HostApi): Promise<{ status: HostOrganizationsStatus | null; error: string | null }> {
  try {
    return { status: await api.hostOrganizations(), error: null }
  } catch (error) {
    return { status: null, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Only a local owner may change how a host is reached (access-policy `local-only`). */
export function canChangeAccess(info: Pick<ConnectionsServerInfo, 'principal'>): boolean {
  return info.principal === 'local-owner'
}

/** Pairing does not exist on a managed host or the workspace service: Solus Cloud owns how they are reached. */
export function hasPairing(info: ConnectionsServerInfo): boolean {
  return info.hostKind === 'personal'
}

/** The note under the Network section: where the host listens, and who may change it. */
export function networkNote(info: Pick<ConnectionsServerInfo, 'principal' | 'host' | 'port' | 'allowLan'>): string {
  const reach = info.allowLan ? 'reachable on your network' : 'this computer only'
  const change = canChangeAccess(info) ? '' : ' Change these from the host itself or from a paired device.'
  return `Listening on ${info.host}:${info.port} · ${reach}.${change}`
}

/** Only the host's owner may read and revoke its pairings (plans/033 §4.4); pairing exists on a personal host only. */
export function showsPairedDevices(info: ConnectionsServerInfo): boolean {
  return hasPairing(info) && (info.principal === 'local-owner' || info.principal === 'remote-owner')
}

/** The line under a paired device: revoked, connected now, or when the host last saw it. */
export function pairedDeviceDetail(device: PairedDevice, isConnected: boolean, now = Date.now()): string {
  const ago = (at: number) => `${relativeTime(new Date(at).toISOString(), now)} ago`
  if (device.revokedAt !== null) return `Revoked ${ago(device.revokedAt)}`
  const seen = isConnected ? 'Connected now' : `Last seen ${ago(device.lastSeenAt)}`
  return `${seen} · paired ${ago(device.pairedAt)}`
}
