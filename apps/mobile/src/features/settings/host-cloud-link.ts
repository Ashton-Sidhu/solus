import { uplinkControl, type UplinkControl } from '@solus/client-core/uplink-control'
import type { UplinkEnrollmentTicket, UplinkStatus } from '@solus/contracts/uplink'
import { Listeners } from '../../lib/listeners'
import type { HostConnection } from '../hosts/host-connections'

/**
 * Each host's registration to the person's Solus Cloud account and, apart from it,
 * its link, as the desktop and web Access tab shows them
 * (docs/adr/0001-standard-authentication.md §2.2 rules 8 and 9). A paired phone is the
 * host's local owner: signed in, it registers a host that is not registered by itself,
 * and it turns the link on and off. A phone that reached the host through the tunnel
 * only sees them (`uplinkControl`). The ticket comes from the phone's own account session.
 */

export type HostCloudLinkState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; control: UplinkControl; status: UplinkStatus | null; busy: boolean }
  | { kind: 'error'; message: string }

const IDLE = { kind: 'idle' } as const

export class HostCloudLink {
  readonly changes = new Listeners()
  private readonly states = new Map<string, HostCloudLinkState>()
  /** One `host.uplinkStatusChanged` subscription per host connection: the tunnel's "online" arrives after `uplinkLink` answers. */
  private readonly watches = new Map<string, { connection: HostConnection; stop: () => void }>()

  constructor(
    private readonly connectionFor: (hostId: string) => HostConnection | null,
    private readonly issueTicket: () => Promise<UplinkEnrollmentTicket | null>,
    /** Whether the phone is signed in to Solus Cloud: then it registers the hosts it manages. */
    private readonly isSignedIn: () => boolean,
  ) {}

  stateOf = (hostId: string): HostCloudLinkState => this.states.get(hostId) ?? IDLE

  async load(hostId: string): Promise<void> {
    const connection = this.connectionFor(hostId)
    if (!connection) {
      this.set(hostId, { kind: 'error', message: 'This host cannot be reached now.' })
      return
    }
    this.watch(hostId, connection)
    if (this.stateOf(hostId).kind !== 'loaded') this.set(hostId, { kind: 'loading' })
    try {
      const control = uplinkControl(await connection.api.connectionsGetServerInfo())
      const status = control === 'none' ? null : await connection.api.uplinkStatus()
      if (this.connectionFor(hostId) !== connection) return
      this.set(hostId, { kind: 'loaded', control, status, busy: false })
      // Rule 8: a signed-in owner's client registers a host that is not registered.
      if (control === 'manage' && status && !status.registration.registered && this.isSignedIn()) {
        await this.register(hostId).catch(() => {})
      }
    } catch (error) {
      if (this.connectionFor(hostId) !== connection) return
      this.set(hostId, { kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Registers the host to the signed-in account. Throws what the account or the host refused. */
  async register(hostId: string): Promise<void> {
    await this.change(hostId, (connection) => this.registerWith(connection))
  }

  /** Turns the tunnel on: the host is reachable from the internet. A host that is not registered is registered first. */
  async link(hostId: string): Promise<void> {
    await this.change(hostId, async (connection) => {
      const current = this.stateOf(hostId)
      const isRegistered = current.kind === 'loaded' && current.status?.registration.registered === true
      if (!isRegistered && !(await this.registerWith(connection)).registration.registered) {
        throw new Error('Solus Cloud did not register this host.')
      }
      return connection.api.uplinkLink()
    })
  }

  /** Turns the tunnel off. The registration stays; it needs no account: the host holds its own key. */
  async unlink(hostId: string): Promise<void> {
    await this.change(hostId, (connection) => connection.api.uplinkUnlink())
  }

  forgetHost(hostId: string): void {
    this.watches.get(hostId)?.stop()
    this.watches.delete(hostId)
    this.states.delete(hostId)
    this.changes.notify()
  }

  private async registerWith(connection: HostConnection): Promise<UplinkStatus> {
    const ticket = await this.issueTicket()
    if (!ticket) throw new Error('Sign in to Solus Cloud to register this host.')
    return connection.api.uplinkRegister({ ticket: ticket.ticket, directoryUrl: ticket.directoryUrl })
  }

  private async change(hostId: string, run: (connection: HostConnection) => Promise<UplinkStatus>): Promise<void> {
    const connection = this.connectionFor(hostId)
    const current = this.stateOf(hostId)
    if (!connection || current.kind !== 'loaded') throw new Error('This host cannot be reached now.')
    if (current.control !== 'manage' || current.busy) return
    this.set(hostId, { ...current, busy: true })
    try {
      const status = await run(connection)
      this.set(hostId, { kind: 'loaded', control: current.control, status, busy: false })
    } catch (error) {
      this.set(hostId, { ...current, busy: false })
      throw error
    }
  }

  private watch(hostId: string, connection: HostConnection): void {
    const existing = this.watches.get(hostId)
    if (existing?.connection === connection) return
    existing?.stop()
    const stop = connection.events.subscribe('host.uplinkStatusChanged', (status) => {
      const current = this.stateOf(hostId)
      if (current.kind === 'loaded') this.set(hostId, { ...current, status })
    })
    this.watches.set(hostId, { connection, stop })
  }

  private set(hostId: string, state: HostCloudLinkState): void {
    this.states.set(hostId, state)
    this.changes.notify()
  }
}

/** The registration row: whose account the host belongs to, or why it is not registered. */
export function cloudRegistrationSummary(state: Extract<HostCloudLinkState, { kind: 'loaded' }>) {
  const { status, control } = state
  const change = control === 'view' ? ' Change it from the host itself or from a paired device.' : ''
  if (!status) return { value: 'Checking', note: 'Reading the registration…' }
  const { registration } = status
  if (!registration.registered) {
    return {
      value: state.busy ? 'Registering' : 'Not registered',
      note: `Signing in registers this host to your account, so your account and your organizations work here.${change}`,
    }
  }
  const owner = registration.owner
  const account = owner ? owner.email ?? owner.name ?? 'your account' : 'your account'
  return { value: 'Registered', note: `Registered to ${account}. Your devices reach it on your local network or by pairing.${change}` }
}

/** The link row: whether the internet reaches the host through its Cloudflare tunnel, and nothing else. */
export function cloudLinkSummary(state: Extract<HostCloudLinkState, { kind: 'loaded' }>) {
  const { status, control } = state
  const change = control === 'view' ? ' Change it from the host itself or from a paired device.' : ''
  const off = `Turn on to expose this host to the internet through a Cloudflare tunnel. Nothing else changes.${change}`
  if (!status || !status.link.linked) return { isLinked: false, note: status?.link.linked === false && status.link.error ? `${status.link.error} ${off}` : off }
  const { link } = status
  const tunnel = link.state.observed === 'online' ? 'tunnel online' : `tunnel offline${link.state.error ? `. ${link.state.error}` : ''}`
  return { isLinked: true, note: `Reachable at ${link.tunnel.hostname} · ${tunnel}.${change}` }
}
