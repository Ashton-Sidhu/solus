import { serverConnections } from '@solus/client-core/server-connections'
import { ALL_HOST_ROLES, COLLABORATION_ONLY_ROLES, type HostRole } from '@solus/client-core/host-roles'
import { isSolusApiId } from '@solus/contracts/uplink'
import { createSubscriber } from 'svelte/reactivity'
import type { HostFacts } from '@solus/client-core/host-facts'
import { Host } from './host.svelte'

const NO_HOST_ROLES: readonly HostRole[] = []

/**
 * One `Host` per host this client talks to, and the three ways to get one
 * (docs/plans/host-model.md §3.3):
 *
 * - the tab: `session.hostFor(tabId)`, or `hosts.get(run.serverId)`
 * - the device: `hosts.device`, the machine the user holds
 * - the Run on picker: `hosts.runOn`
 *
 * A reader names the owner it means. There is no "the host".
 */
class Hosts {
  // Not reactive on purpose: `get` is called from `$derived`, and a host is
  // created there. Each `Host`'s facts are the reactive part.
  readonly #byId = new Map<string, Host>()
  /** Re-runs a reader when the device or Run on answer may have moved. */
  readonly #placement = createSubscriber((update) => {
    const stops = [
      serverConnections.onConnectionCreated(update),
      serverConnections.onPrimaryChange(update),
      serverConnections.onPhaseChange(update),
    ]
    return () => { for (const stop of stops) stop() }
  })

  constructor() {
    serverConnections.onConnectionCreated((connection) => {
      this.#byId.get(connection.serverId)?.bind(connection.facts)
    })
  }

  /** The host with this id (or installation id). Opens its connection on first use. */
  get(serverId: string): Host {
    return this.#hostFor(serverConnections.factsFor(serverId))
  }

  /** The host for an id this client may not know (deleted, or never listed
   *  here); null rather than a connection to nowhere. */
  find(serverId: string | null | undefined): Host | null {
    if (!serverId) return null
    const resolvedId = serverConnections.resolveId(serverId)
    return serverConnections.isKnownServer(resolvedId) ? this.get(resolvedId) : null
  }

  /** The host on the machine the user holds: the desktop's local server. Null on
   *  web and mobile. Device features (voice, screenshots, terminals) read it. */
  get device(): Host | null {
    this.#placement()
    const serverId = serverConnections.localServerId()
    return serverId ? this.get(serverId) : null
  }

  /** The host the Run on picker selects when nothing narrower names one. */
  get runOn(): Host | null {
    this.#placement()
    const serverId = serverConnections.runOnHostId()
    return serverId ? this.get(serverId) : null
  }

  /** The host that transcribes this client's microphone: the device when there
   *  is one (only the desktop main process transcribes), else the Run on host. */
  get transcription(): Host | null {
    return this.device ?? this.runOn
  }

  /** Which planes a host serves, for an id that may not be known. An unknown
   *  host serves nothing, so no gate offers work or records on it. */
  rolesFor(serverId: string | null | undefined): readonly HostRole[] {
    if (!serverId) return ALL_HOST_ROLES
    // Asking which planes a host serves never opens a connection to it: a host
    // with none reads as assumed, and reads again when its connection appears.
    this.#placement()
    const resolvedId = serverConnections.resolveId(serverId)
    const facts = serverConnections.connectionFor(resolvedId)?.facts
    return facts ? this.#hostFor(facts).roles : this.#assumedRoles(resolvedId)
  }

  hasExecution(serverId: string | null | undefined): boolean {
    return this.rolesFor(serverId).includes('execution')
  }

  hasCollaboration(serverId: string | null | undefined): boolean {
    return this.rolesFor(serverId).includes('collaboration')
  }

  #hostFor(facts: HostFacts): Host {
    const serverId = facts.serverId
    const existing = this.#byId.get(serverId)
    if (existing) {
      // A replaced connection rebinds on its created event; this catches a
      // borrowed one released and opened again. Outside the read: binding writes state.
      if (!existing.isBoundTo(facts)) queueMicrotask(() => existing.bind(facts))
      return existing
    }
    const host = new Host(serverId, facts, () => this.#assumedRoles(serverId))
    this.#byId.set(serverId, host)
    return host
  }

  #assumedRoles(serverId: string): readonly HostRole[] {
    if (isSolusApiId(serverId)) return COLLABORATION_ONLY_ROLES
    return serverConnections.isKnownServer(serverId) ? ALL_HOST_ROLES : NO_HOST_ROLES
  }
}

export const hosts = new Hosts()
export type { Host }
