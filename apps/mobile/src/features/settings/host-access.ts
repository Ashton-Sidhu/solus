import type { HostApi } from '@solus/client-core/host-api'
import type { ConnectionsServerInfo, PairedHostSummary } from '@solus/contracts/host-api'
import type { HostOrganizationsStatus } from '@solus/contracts/organization-scope'
import { Listeners } from '../../lib/listeners'
import type { HostConnection } from '../hosts/host-connections'

/**
 * How one host is reached and who reaches it, as the desktop and web Access tab
 * shows it: its network, the pairing code it hands out, the devices with access,
 * its organizations, and the hosts it paired with. Only the host's local owner (the desktop on the machine
 * or a paired device, this phone included) changes how it is reached; the host
 * refuses anyone else, so the screen offers those controls to a local owner only.
 * The Solus Cloud link is `HostCloudLink`.
 */

export type HostEndpoint = Awaited<ReturnType<HostApi['connectionsListEndpoints']>>[number]
export type HostDevice = Awaited<ReturnType<HostApi['connectionsListSessions']>>[number]
export type HostPairCode = Awaited<ReturnType<HostApi['connectionsGeneratePairToken']>>

/** The one change in flight, so its control shows progress and the others wait. */
export type HostAccessAction = 'remote-access' | 'trust-local-network' | 'pair' | 'pair-host' | `revoke:${string}` | `insights:${string}` | `forget-host:${string}`

export interface HostAccessSnapshot {
  info: ConnectionsServerInfo
  endpoints: HostEndpoint[]
  devices: HostDevice[]
  organizations: HostOrganizationsStatus | null
  /** Why the organizations could not be read; the rest of the screen still shows. */
  organizationsError: string | null
  /** The hosts this host paired with (docs/plans/cross-host-sessions.md §10); null when they could not be read. */
  pairedHosts: PairedHostSummary[] | null
  pairedHostsError: string | null
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
      const [info, endpoints, devices, organizations, pairedHosts] = await Promise.all([
        connection.api.connectionsGetServerInfo(),
        connection.api.connectionsListEndpoints(),
        connection.api.connectionsListSessions(),
        readOrganizations(connection.api),
        readPairedHosts(connection.api),
      ])
      if (this.connectionFor(hostId) !== connection) return
      const latest = this.stateOf(hostId)
      this.set(hostId, {
        kind: 'loaded',
        info,
        endpoints,
        devices,
        organizations: organizations.status,
        organizationsError: organizations.error,
        pairedHosts: pairedHosts.hosts,
        pairedHostsError: pairedHosts.error,
        // A code handed out before the reload stays on screen until it expires.
        pair: latest.kind === 'loaded' ? latest.pair : null,
        busy: latest.kind === 'loaded' ? latest.busy : null,
      })
    } catch (error) {
      if (this.connectionFor(hostId) !== connection) return
      this.set(hostId, { kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async setRemoteAccess(hostId: string, remoteAccess: boolean): Promise<void> {
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

  async generatePairCode(hostId: string): Promise<void> {
    await this.change(hostId, 'pair', async (api) => ({ pair: await api.connectionsGeneratePairToken() }))
  }

  async revokeDevice(hostId: string, deviceId: string): Promise<void> {
    await this.change(hostId, `revoke:${deviceId}`, async (api) => {
      await api.connectionsRevokeDevice({ deviceId })
      return { devices: await api.connectionsListSessions() }
    })
  }

  /** Pairs this host with another host, so its agents can start sessions there. */
  async pairHost(hostId: string, url: string, code: string): Promise<void> {
    await this.change(hostId, 'pair-host', async (api) => {
      await api.pairedHostsPair({ url, code })
      return { pairedHosts: await api.pairedHostsList(), pairedHostsError: null }
    })
  }

  /** Forgets one pairing on this host; the other host lists this one as a device until it is revoked there. */
  async forgetPairedHost(hostId: string, installationId: string): Promise<void> {
    await this.change(hostId, `forget-host:${installationId}`, async (api) => {
      await api.pairedHostsForget({ installationId })
      return { pairedHosts: await api.pairedHostsList(), pairedHostsError: null }
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
    const stop = connection.events.subscribe('host.organizationsChanged', (status) => {
      const current = this.stateOf(hostId)
      if (current.kind === 'loaded') this.set(hostId, { ...current, organizations: status, organizationsError: null })
    })
    this.watches.set(hostId, { connection, stop })
  }

  private set(hostId: string, state: HostAccessState): void {
    this.states.set(hostId, state)
    this.changes.notify()
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

/** A caller that may not read the paired hosts (not the host's administrator) says why; the rest of the screen still shows. */
async function readPairedHosts(api: HostApi): Promise<{ hosts: PairedHostSummary[] | null; error: string | null }> {
  try {
    return { hosts: await api.pairedHostsList(), error: null }
  } catch (error) {
    return { hosts: null, error: error instanceof Error ? error.message : String(error) }
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
