import { uplinkControl, type UplinkControl } from '@solus/client-core/uplink-control'
import type { UplinkEnrollmentTicket, UplinkStatus } from '@solus/contracts/uplink'
import { Listeners } from '../../lib/listeners'
import type { HostConnection } from '../hosts/host-connections'

/**
 * Each host's link to the person's Solus Cloud account, as the desktop and web
 * Access tab shows it. A paired phone is the host's local owner, so it links and
 * unlinks; a phone that reached the host through the tunnel only sees the link
 * (`uplinkControl`). The ticket comes from the phone's own account session.
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
    } catch (error) {
      if (this.connectionFor(hostId) !== connection) return
      this.set(hostId, { kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Links the host to the signed-in account. Throws what the account or the host refused. */
  async link(hostId: string): Promise<void> {
    await this.change(hostId, async (connection) => {
      const ticket = await this.issueTicket()
      if (!ticket) throw new Error('Sign in to Solus Cloud to link this host.')
      return connection.api.uplinkLink({ ticket: ticket.ticket, directoryUrl: ticket.directoryUrl })
    })
  }

  /** Unlinking needs no account: the host holds its own token for that. */
  async unlink(hostId: string): Promise<void> {
    await this.change(hostId, (connection) => connection.api.uplinkUnlink())
  }

  forgetHost(hostId: string): void {
    this.watches.get(hostId)?.stop()
    this.watches.delete(hostId)
    this.states.delete(hostId)
    this.changes.notify()
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

/** The row value and the note under the Solus Cloud section of a loaded host. */
export function cloudLinkSummary(state: Extract<HostCloudLinkState, { kind: 'loaded' }>) {
  const { status, control } = state
  const change = control === 'view' ? ' Change the link from the host itself or from a paired device.' : ''
  if (!status) return { value: 'Checking', note: 'Reading the link…' }
  if (!status.linked) {
    return {
      value: 'Not linked',
      note: status.error ?? `Link this host to reach it from your other devices through your Solus account.${change}`,
    }
  }
  const tunnel = status.state.observed === 'online' ? 'tunnel online' : `tunnel offline${status.state.error ? `. ${status.state.error}` : ''}`
  return { value: 'Linked', note: `Reachable at ${status.link.hostname} · ${tunnel}.${change}` }
}
