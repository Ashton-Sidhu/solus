import type { HostApi } from '@solus/client-core/host-api'
import type { AppAccess, AppAddress, ConnectionsServerInfo, PairedDevice } from '@solus/contracts/host-api'
import type { HostOrganizationsStatus } from '@solus/contracts/organization-scope'
import { Listeners } from '../../lib/listeners'
import { relativeTime } from '../../lib/time'
import type { HostConnection } from '../hosts/host-connections'

/**
 * How one host is reached and who reaches it, as the desktop and web Access tab
 * shows it: its network, the pairing code it hands out, the devices with access,
 * its organizations, and how outside apps reach its tools (plans/035 §10). Only the host's local owner (the desktop on the machine
 * or a paired device, this phone included) changes how it is reached; the host
 * refuses anyone else, so the screen offers those controls to a local owner only.
 * The Solus Cloud link is `HostCloudLink`.
 */

export type HostEndpoint = Awaited<ReturnType<HostApi['connectionsListEndpoints']>>[number]
export type HostDevice = Awaited<ReturnType<HostApi['connectionsListSessions']>>[number]
export type HostPairCode = Awaited<ReturnType<HostApi['connectionsGeneratePairToken']>>
export type HostAppEndpoint = Awaited<ReturnType<HostApi['connectionsAppEndpoint']>>
export type HostAppPairCode = Awaited<ReturnType<HostApi['connectionsCreateAppPairingCode']>>

/** The one change in flight, so its control shows progress and the others wait. */
export type HostAccessAction = 'remote-access' | 'trust-local-network' | 'tailscale-serve' | 'pair' | 'app-pair' | 'revoke-apps' | `revoke:${string}` | `insights:${string}`

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
  /** Where an outside app reaches this host's tools. Only the host's owner may read it. */
  appEndpoint: HostAppEndpoint | null
  /** Why the app address could not be read; the rest of the screen still shows. */
  appEndpointError: string | null
  /** The one-time code an outside app's sign-in page accepts. */
  appPair: HostAppPairCode | null
  busy: HostAccessAction | null
}

/**
 * The host's test of one app address from outside, as an app would ask it
 * (`connectionsTestAppAddress`). `url` is the address tested: a test of an
 * address the host no longer gives says nothing about the new one.
 */
export type AppAddressTestState =
  | { kind: 'running'; url: string }
  | { kind: 'done'; url: string; reachable: boolean; reason: string | null }
  | { kind: 'error'; url: string; message: string }

export type HostAccessState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | ({ kind: 'loaded' } & HostAccessSnapshot)
  | { kind: 'error'; message: string }

const IDLE = { kind: 'idle' } as const

export class HostAccess {
  readonly changes = new Listeners()
  private readonly states = new Map<string, HostAccessState>()
  private readonly addressTests = new Map<string, AppAddressTestState>()
  /** One `host.organizationsChanged` subscription per host connection. */
  private readonly watches = new Map<string, { connection: HostConnection; stop: () => void }>()

  constructor(private readonly connectionFor: (hostId: string) => HostConnection | null) {}

  stateOf = (hostId: string): HostAccessState => this.states.get(hostId) ?? IDLE

  addressTestOf = (hostId: string): AppAddressTestState | null => this.addressTests.get(hostId) ?? null

  /** The host asks this address of its own from outside. A newer test, or another connection, drops the answer. */
  async testAppAddress(hostId: string, address: Pick<AppAddress, 'source' | 'url'>): Promise<void> {
    const connection = this.connectionFor(hostId)
    const current = this.addressTests.get(hostId)
    if (current?.kind === 'running' && current.url === address.url) return
    if (!connection) {
      this.setAddressTest(hostId, { kind: 'error', url: address.url, message: 'This host cannot be reached now.' })
      return
    }
    const running: AppAddressTestState = { kind: 'running', url: address.url }
    this.setAddressTest(hostId, running)
    let answer: AppAddressTestState
    try {
      const result = await connection.api.connectionsTestAppAddress({ source: address.source })
      answer = { kind: 'done', url: address.url, reachable: result.reachable, reason: result.reason }
    } catch (error) {
      answer = { kind: 'error', url: address.url, message: error instanceof Error ? error.message : String(error) }
    }
    if (this.addressTests.get(hostId) !== running || this.connectionFor(hostId) !== connection) return
    this.setAddressTest(hostId, answer)
  }

  /** Reads the app addresses again, as after a change of the person's own address. */
  async refreshAppEndpoint(hostId: string): Promise<void> {
    const connection = this.connectionFor(hostId)
    if (!connection || this.stateOf(hostId).kind !== 'loaded') return
    const appEndpoint = await readAppEndpoint(connection.api)
    const latest = this.stateOf(hostId)
    if (this.connectionFor(hostId) !== connection || latest.kind !== 'loaded') return
    this.dropFinishedAddressTest(hostId)
    this.set(hostId, { ...latest, appEndpoint: appEndpoint.endpoint, appEndpointError: appEndpoint.error })
  }

  /** Reads the pairings again, as when the person comes back from an app that signed in. The rest stays as it is. */
  async refreshPairedDevices(hostId: string): Promise<void> {
    const connection = this.connectionFor(hostId)
    if (!connection || this.stateOf(hostId).kind !== 'loaded') return
    const paired = await readPairedDevices(connection.api)
    const latest = this.stateOf(hostId)
    if (this.connectionFor(hostId) !== connection || latest.kind !== 'loaded') return
    this.set(hostId, { ...latest, pairedDevices: paired.devices, pairedDevicesError: paired.error })
  }

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
      const [info, endpoints, devices, paired, organizations, appEndpoint] = await Promise.all([
        connection.api.connectionsGetServerInfo(),
        connection.api.connectionsListEndpoints(),
        connection.api.connectionsListSessions(),
        readPairedDevices(connection.api),
        readOrganizations(connection.api),
        readAppEndpoint(connection.api),
      ])
      if (this.connectionFor(hostId) !== connection) return
      const latest = this.stateOf(hostId)
      // A new read asks the address again: what answered before may not answer now.
      this.dropFinishedAddressTest(hostId)
      this.set(hostId, {
        kind: 'loaded',
        info,
        endpoints,
        devices,
        pairedDevices: paired.devices,
        pairedDevicesError: paired.error,
        organizations: organizations.status,
        organizationsError: organizations.error,
        appEndpoint: appEndpoint.endpoint,
        appEndpointError: appEndpoint.error,
        // A code handed out before the reload stays on screen until it expires.
        pair: latest.kind === 'loaded' ? latest.pair : null,
        appPair: latest.kind === 'loaded' ? latest.appPair : null,
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

  async createAppPairCode(hostId: string, access: AppAccess): Promise<void> {
    await this.change(hostId, 'app-pair', async (api) => ({ appPair: await api.connectionsCreateAppPairingCode({ access }) }))
  }

  async revokeDevice(hostId: string, deviceId: string): Promise<void> {
    await this.change(hostId, `revoke:${deviceId}`, async (api) => {
      await api.connectionsRevokeDevice({ deviceId })
      const [devices, paired] = await Promise.all([api.connectionsListSessions(), readPairedDevices(api)])
      return { devices, pairedDevices: paired.devices, pairedDevicesError: paired.error }
    })
  }

  /**
   * Revokes each of these devices, one request each, then reads the pairings once. A device the
   * host refused stays in the list; the first refusal is thrown after the list is read again.
   */
  async revokeDevices(hostId: string, deviceIds: readonly string[]): Promise<void> {
    const refusals: unknown[] = []
    await this.change(hostId, 'revoke-apps', async (api) => {
      const results = await Promise.allSettled(deviceIds.map((deviceId) => api.connectionsRevokeDevice({ deviceId })))
      for (const result of results) if (result.status === 'rejected') refusals.push(result.reason)
      const [devices, paired] = await Promise.all([api.connectionsListSessions(), readPairedDevices(api)])
      return { devices, pairedDevices: paired.devices, pairedDevicesError: paired.error }
    })
    if (refusals.length > 0) throw refusals[0]
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
    this.addressTests.delete(hostId)
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
    // The person's own address is a host setting (`publicAddress`); the app addresses follow it.
    const stopConfig = connection.events.subscribe('config.changed', () => void this.refreshAppEndpoint(hostId))
    this.watches.set(hostId, { connection, stop: () => { stopOrganizations(); stopServe(); stopConfig() } })
  }

  private dropFinishedAddressTest(hostId: string): void {
    if (this.addressTests.get(hostId)?.kind !== 'running') this.addressTests.delete(hostId)
  }

  private setAddressTest(hostId: string, state: AppAddressTestState): void {
    this.addressTests.set(hostId, state)
    this.changes.notify()
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

/** A host that refuses the app address (to anyone but its owner) says why; the rest of the screen still shows. */
async function readAppEndpoint(api: HostApi): Promise<{ endpoint: HostAppEndpoint | null; error: string | null }> {
  try {
    return { endpoint: await api.connectionsAppEndpoint(), error: null }
  } catch (error) {
    return { endpoint: null, error: error instanceof Error ? error.message : String(error) }
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

/** Pairing does not exist on a cloud machine or the workspace service: the control plane owns how they are reached. */
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

/** An outside app that still reaches this host's tools: one grant, from one sign-in. */
export type ConnectedApp = PairedDevice & { app: NonNullable<PairedDevice['app']> }

/** The outside apps that still reach this host's tools; a revoked app signs in again as a new one. */
export function connectedApps(devices: PairedDevice[]): ConnectedApp[] {
  return devices.filter((device): device is ConnectedApp => device.app !== undefined && device.revokedAt === null)
}

/** A device the host paired, as Sharing & access lists it under Devices. */
export interface PairedDeviceRow {
  deviceId: string
  label: string
  /** "Connected now", or when the host last saw it. */
  detail: string
}

/**
 * The devices that still have access, not the outside apps: the ones connected
 * now first, then the most recently seen. Only the owner reads them.
 */
export function pairedDeviceRows(snapshot: Pick<HostAccessSnapshot, 'pairedDevices' | 'devices'>, now = Date.now()): PairedDeviceRow[] {
  const connected = new Set(snapshot.devices.flatMap((device) => (device.deviceId ? [device.deviceId] : [])))
  return snapshot.pairedDevices
    .filter((device) => device.app === undefined && device.revokedAt === null)
    .map((device) => ({ device, isConnected: connected.has(device.deviceId) }))
    .sort((a, b) => Number(b.isConnected) - Number(a.isConnected) || b.device.lastSeenAt - a.device.lastSeenAt)
    .map(({ device, isConnected }) => ({
      deviceId: device.deviceId,
      label: device.deviceLabel,
      detail: isConnected ? 'Connected now' : `Last seen ${relativeTime(new Date(device.lastSeenAt).toISOString(), now)} ago`,
    }))
}
