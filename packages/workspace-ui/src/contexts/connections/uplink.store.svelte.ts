import type { UplinkStatus } from '@solus/contracts/uplink'
import { serverConnections } from '@solus/client-core/server-connections'
import { uplinkAccountSource } from '@solus/client-core/uplink-account'
import { SvelteMap } from 'svelte/reactivity'
import { toasts } from '../../lib/toasts'
import { accountStore } from '../account/account.store.svelte'
import { serversStore } from './servers.store.svelte'

/**
 * A host's link to the owner's Solus cloud account (docs/plans/personal-uplink.md,
 * C4). Read per host from `uplinkStatus`; changed through `uplinkLink` and
 * `uplinkUnlink`, which only a local connection may call — the Access tab shows the
 * control only when the connected principal is the local owner.
 */
class UplinkStore {
  readonly statusByServer = new SvelteMap<string, UplinkStatus>()
  busyServerId = $state<string | null>(null)

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

  async refresh(serverId: string): Promise<void> {
    try {
      this.statusByServer.set(serverId, await serverConnections.apiFor(serverId).uplinkStatus())
    } catch {
      // An older host without the method; the section shows "checking" until it answers.
    }
  }

  async link(serverId: string): Promise<void> {
    if (this.busyServerId) return
    const source = uplinkAccountSource()
    if (!source) return
    this.busyServerId = serverId
    try {
      const ticket = await source.issueEnrollmentTicket()
      if (!ticket) {
        toasts.error('Sign in to Solus cloud to link this host')
        return
      }
      const status = await serverConnections.apiFor(serverId).uplinkLink({
        ticket: ticket.ticket,
        directoryUrl: ticket.directoryUrl,
      })
      this.statusByServer.set(serverId, status)
      if (status.linked) toasts.success(`Linked · reachable at ${status.link.hostname}`)
      void serversStore.refreshDirectory()
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : String(err))
    } finally {
      this.busyServerId = null
    }
  }

  async unlink(serverId: string): Promise<void> {
    if (this.busyServerId) return
    this.busyServerId = serverId
    try {
      const status = await serverConnections.apiFor(serverId).uplinkUnlink()
      this.statusByServer.set(serverId, status)
      toasts.info('Unlinked from Solus cloud')
      void serversStore.refreshDirectory()
    } catch (err) {
      toasts.error(err instanceof Error ? err.message : String(err))
    } finally {
      this.busyServerId = null
    }
  }
}

export const uplinkStore = new UplinkStore()
