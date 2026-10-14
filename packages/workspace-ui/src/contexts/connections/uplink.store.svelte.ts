import type { UplinkStatus } from '@solus/contracts/uplink'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { serverConnections } from '@solus/client-core/server-connections'
import { uplinkAccountSource } from '@solus/client-core/uplink-account'
import { uplinkControl, type UplinkControl } from '@solus/client-core/uplink-control'
import { LOCAL_SERVER_ID } from '@solus/client-core/server-registry'
import { SvelteMap } from 'svelte/reactivity'
import { toasts } from '../../lib/toasts'
import { accountStore } from '../account/account.store.svelte'
import { serversStore } from './servers.store.svelte'

/**
 * A host's registration to the owner's Solus account and, apart from it, its link
 * (docs/adr/0001-standard-authentication.md §2.2 rules 8 and 9). Read per host from
 * `uplinkStatus`; changed through `uplinkRegister`, `uplinkLink`, and `uplinkUnlink`,
 * which only a local connection may call — `controlFor` says whether this client is
 * one for that host. A signed-in client registers a host it manages by itself; the
 * desktop's own host is registered by the desktop's main process, which holds the
 * sign-in. Linking only exposes the host to the internet.
 */
class UplinkStore {
  readonly statusByServer = new SvelteMap<string, UplinkStatus>()
  private readonly controlByServer = new SvelteMap<string, UplinkControl>()
  busyServerId = $state<string | null>(null)
  private stopListening: (() => void) | null = null

  /** This client can hold an account at all: the desktop bridge exists, or the
   *  cloud origin serves this web client. Signed out still shows the card — as
   *  its sign-in state, never as nothing. */
  get accountAvailable(): boolean {
    return uplinkAccountSource() !== null
  }

  /** An account is at hand to issue tickets: the desktop is signed in, or this web
   *  client is served by the account origin and the cookie is live. */
  get canLink(): boolean {
    if (!this.accountAvailable) return false
    return accountStore.isSignedIn || serversStore.directorySignedIn === true
  }

  statusFor(serverId: string): UplinkStatus | undefined {
    return this.statusByServer.get(serverId)
  }

  /** `none` until the host says how this client was admitted. */
  controlFor(serverId: string): UplinkControl {
    return this.controlByServer.get(serverId) ?? 'none'
  }

  /** Called once at boot: the host sends a snapshot on every change of its registration or its tunnel. */
  listen(): () => void {
    if (this.stopListening) return this.stopListening
    this.stopListening = subscribeAllHosts('host.uplinkStatusChanged', (serverId, status) => {
      this.statusByServer.set(serverId, status)
    })
    return () => {
      this.stopListening?.()
      this.stopListening = null
    }
  }

  async refresh(serverId: string): Promise<void> {
    try {
      const control = uplinkControl(await serverConnections.serverInfoFor(serverId))
      this.controlByServer.set(serverId, control)
      if (control === 'none') return
      const status = await serverConnections.apiFor(serverId).uplinkStatus()
      this.statusByServer.set(serverId, status)
      // Rule 8: a signed-in owner's client registers a host that is not registered.
      if (control === 'manage' && serverId !== LOCAL_SERVER_ID && this.canLink && !status.registration.registered) {
        await this.register(serverId, { quiet: true })
      }
    } catch {
      // An older host without the method; the section shows "checking" until it answers.
    }
  }

  /** Registers the host with a ticket this client's account issues. `quiet` for the automatic registration: no toast. */
  async register(serverId: string, options: { quiet?: boolean } = {}): Promise<boolean> {
    if (this.busyServerId) return false
    const source = uplinkAccountSource()
    if (!source) return false
    this.busyServerId = serverId
    try {
      const ticket = await source.issueEnrollmentTicket()
      if (!ticket) {
        if (!options.quiet) toasts.error('Sign in to Solus cloud to register this host')
        return false
      }
      const status = await serverConnections.apiFor(serverId).uplinkRegister({ ticket: ticket.ticket, directoryUrl: ticket.directoryUrl })
      this.statusByServer.set(serverId, status)
      if (!options.quiet && status.registration.registered) toasts.success('Registered to your account')
      void serversStore.refreshDirectory()
      return status.registration.registered
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      this.busyServerId = null
    }
  }

  /** Turns the tunnel on (rule 9). A host that is not registered is registered first. */
  async link(serverId: string): Promise<void> {
    if (this.busyServerId) return
    if (this.statusFor(serverId)?.registration.registered !== true && !(await this.register(serverId, { quiet: true }))) return
    this.busyServerId = serverId
    try {
      const status = await serverConnections.apiFor(serverId).uplinkLink()
      this.statusByServer.set(serverId, status)
      if (status.link.linked) toasts.success(`Reachable from the internet at ${status.link.tunnel.hostname}`)
      void serversStore.refreshDirectory()
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : String(err))
    } finally {
      this.busyServerId = null
    }
  }

  /** Turns the tunnel off. The registration stays. */
  async unlink(serverId: string): Promise<void> {
    if (this.busyServerId) return
    this.busyServerId = serverId
    try {
      const status = await serverConnections.apiFor(serverId).uplinkUnlink()
      this.statusByServer.set(serverId, status)
      toasts.info('No longer reachable from the internet')
      void serversStore.refreshDirectory()
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : String(err))
    } finally {
      this.busyServerId = null
    }
  }
}

export const uplinkStore = new UplinkStore()
