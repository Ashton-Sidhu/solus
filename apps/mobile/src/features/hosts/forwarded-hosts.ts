import type { HostApi } from '@solus/client-core/host-api'
import type { HostEventMap, HostEventName } from '@solus/contracts/host-events'
import type { ForwardedHost, SshAddLink } from '@solus/contracts/remote-machines'
import { Listeners } from '../../lib/listeners'

/**
 * The forwards each connected host holds to machines added over SSH without an
 * account (docs/plans/host-routes.md D7, D9). Only that host dials them; this
 * phone shows them, removes them, and links them to the account, which makes
 * them reachable from the phone through the tunnel.
 */

export interface ForwardedHostsConnection {
  readonly api: Pick<HostApi, 'hostsListForwarded' | 'hostsRemoveForwarded' | 'hostsLinkForwarded'>
  readonly events: { subscribe<K extends HostEventName>(type: K, listener: (payload: HostEventMap[K]) => void): () => void }
}

export type ForwardedHostsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  /** `busyIds` names the forwarded hosts a remove or a link is running for. */
  | { kind: 'loaded'; hosts: readonly ForwardedHost[]; busyIds: readonly string[] }
  | { kind: 'error'; message: string }

const IDLE = { kind: 'idle' } as const

export class ForwardedHosts {
  readonly changes = new Listeners()
  private readonly states = new Map<string, ForwardedHostsState>()
  /** One `host.forwardedHostsChanged` subscription per host connection. */
  private readonly watches = new Map<string, { connection: ForwardedHostsConnection; stop: () => void }>()

  constructor(
    private readonly connectionFor: (hostId: string) => ForwardedHostsConnection | null,
    private readonly issueTicket: () => Promise<SshAddLink | null>,
    /** A link put the machine in the account's directory: the phone reads it again. */
    private readonly onLinked: () => void,
  ) {}

  stateOf = (hostId: string): ForwardedHostsState => this.states.get(hostId) ?? IDLE

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
      const hosts = await connection.api.hostsListForwarded()
      if (this.connectionFor(hostId) !== connection) return
      const latest = this.stateOf(hostId)
      this.set(hostId, { kind: 'loaded', hosts, busyIds: latest.kind === 'loaded' ? latest.busyIds : [] })
    } catch (error) {
      if (this.connectionFor(hostId) !== connection) return
      this.set(hostId, { kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Closes the forward. `stopRemote` also stops the Solus that Solus started there. */
  async remove(hostId: string, installationId: string, stopRemote: boolean): Promise<void> {
    await this.change(hostId, installationId, async (connection) => {
      await connection.api.hostsRemoveForwarded({ installationId, stopRemote })
      const current = this.stateOf(hostId)
      if (current.kind === 'loaded') this.set(hostId, { ...current, hosts: current.hosts.filter((host) => host.installationId !== installationId) })
    })
  }

  /** Links the machine to the account over the same SSH target. The forward stays as a route (D9). */
  async link(hostId: string, installationId: string): Promise<void> {
    await this.change(hostId, installationId, async (connection) => {
      const ticket = await this.issueTicket()
      if (!ticket) throw new Error('Sign in to Solus Cloud to link this machine to your account.')
      await connection.api.hostsLinkForwarded({ installationId, link: { ticket: ticket.ticket, directoryUrl: ticket.directoryUrl } })
      const current = this.stateOf(hostId)
      if (current.kind === 'loaded') {
        this.set(hostId, { ...current, hosts: current.hosts.map((host) => host.installationId === installationId ? { ...host, isLinked: true } : host) })
      }
      this.onLinked()
    })
  }

  forgetHost(hostId: string): void {
    this.watches.get(hostId)?.stop()
    this.watches.delete(hostId)
    this.states.delete(hostId)
    this.changes.notify()
  }

  private async change(hostId: string, installationId: string, run: (connection: ForwardedHostsConnection) => Promise<void>): Promise<void> {
    const connection = this.connectionFor(hostId)
    if (!connection) throw new Error('This host cannot be reached now.')
    const before = this.stateOf(hostId)
    if (before.kind === 'loaded' && before.busyIds.includes(installationId)) return
    if (before.kind === 'loaded') this.set(hostId, { ...before, busyIds: [...before.busyIds, installationId] })
    try {
      await run(connection)
    } finally {
      const after = this.stateOf(hostId)
      if (after.kind === 'loaded') this.set(hostId, { ...after, busyIds: after.busyIds.filter((id) => id !== installationId) })
    }
  }

  private watch(hostId: string, connection: ForwardedHostsConnection): void {
    const existing = this.watches.get(hostId)
    if (existing?.connection === connection) return
    existing?.stop()
    const stop = connection.events.subscribe('host.forwardedHostsChanged', ({ hosts }) => {
      const current = this.stateOf(hostId)
      this.set(hostId, { kind: 'loaded', hosts, busyIds: current.kind === 'loaded' ? current.busyIds : [] })
    })
    this.watches.set(hostId, { connection, stop })
  }

  private set(hostId: string, state: ForwardedHostsState): void {
    this.states.set(hostId, state)
    this.changes.notify()
  }
}

/** How one forwarded host reads in its holder's details. */
export interface ForwardedHostRow {
  /** The state in a word or two. */
  readonly status: string
  /** Why, or how the phone reaches it. */
  readonly note: string
  /** `muted`: a linked host's failed forward is not an error while the tunnel works (D9). */
  readonly tone: 'default' | 'muted' | 'danger'
  readonly canLink: boolean
}

export function forwardedHostRow(host: ForwardedHost, holderLabel: string): ForwardedHostRow {
  const reach = host.isLinked
    ? 'Linked to your account: this phone reaches it through your account’s tunnel.'
    : `Reachable only from ${holderLabel}. Link it to your account to reach it from this phone.`
  const canLink = !host.isLinked
  switch (host.state) {
    case 'open':
      return { status: 'Connected over SSH', note: reach, tone: 'default', canLink }
    case 'reconnecting':
      return { status: 'Reconnecting', note: `${holderLabel} is opening the SSH forward again. ${reach}`, tone: 'default', canLink }
    case 'failed':
      if (host.isLinked) return { status: 'SSH route paused', note: 'SSH route paused — using your account’s tunnel.', tone: 'muted', canLink }
      return { status: 'Failed', note: `${host.error ?? 'The SSH forward stopped.'} ${reach}`, tone: 'danger', canLink }
  }
}

/**
 * The ways to remove a forward. Stopping Solus there is offered only for a server
 * that Solus started; for a linked host, removing closes only the SSH route (D9),
 * because stopping the server would also take it off the account's tunnel.
 */
/** The question a removal asks, and whether it offers to stop Solus there. */
export interface ForwardedRemoveChoice {
  title: string
  message: string
  offersStop: boolean
}

export function forwardedRemoveChoice(host: ForwardedHost, holderLabel: string): ForwardedRemoveChoice {
  if (host.isLinked) {
    return {
      title: `Remove the SSH route to ${host.label}?`,
      message: `${holderLabel} closes its SSH forward. ${host.label} stays linked to your account and reachable through its tunnel.`,
      offersStop: false,
    }
  }
  return {
    title: `Remove ${host.label}?`,
    message: host.startedBySolus
      ? `${holderLabel} closes its SSH forward. Solus started the server on ${host.label}: you can also stop it there.`
      : `${holderLabel} closes its SSH forward. The Solus server on ${host.label} keeps running.`,
    offersStop: host.startedBySolus,
  }
}
