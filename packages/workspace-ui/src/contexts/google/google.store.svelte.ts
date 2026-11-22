import type { GoogleAuthStatus } from '@solus/contracts/google-auth'
import { missingGoogleScopes } from '@solus/contracts/google-auth'
import { serverConnections } from '@solus/client-core/server-connections'
import { localApi } from '@solus/client-core/local-api'
import { SvelteMap } from 'svelte/reactivity'

/**
 * The Google Drive connection of each host, as the host reports it. No
 * credential is kept here: the sign-in happens in the browser and lands on the
 * host, so the renderer only reads the result back.
 */
export class GoogleStore {
  private statuses = new SvelteMap<string, GoogleAuthStatus>()
  private connectingServers = new SvelteMap<string, boolean>()
  private statusRequests = new Map<string, Promise<void>>()

  statusLoaded(serverId: string): boolean {
    return this.statuses.has(serverId)
  }

  connected(serverId: string): boolean {
    return this.statuses.get(serverId)?.connected === true
  }

  /** False when the build ships no Google OAuth client, so no sign-in exists. */
  configured(serverId: string): boolean {
    return this.statuses.get(serverId)?.configured === true
  }

  /** A grant approved before `drive.readonly` shipped still publishes, so this
   *  is a prompt beside a working connection rather than a disconnected state. */
  needsDriveReadScope(serverId: string): boolean {
    const status = this.statuses.get(serverId)
    return status?.connected === true && missingGoogleScopes(status.scopes).length > 0
  }

  connecting(serverId: string): boolean {
    return this.connectingServers.get(serverId) === true
  }

  /** First caller pays for the fetch; everyone after reads the cached status. */
  ensureStatus(serverId: string): Promise<void> {
    if (this.statusLoaded(serverId)) return Promise.resolve()
    return this.statusRequests.get(serverId) ?? this.refresh(serverId)
  }

  refresh(serverId: string): Promise<void> {
    const request = serverConnections.apiFor(serverId).googleStatus()
      .then((status) => { this.statuses.set(serverId, status) })
      .catch((error) => {
        console.error('googleStatus failed', error)
        // An unanswered host has no sign-in to offer; the row hides until it answers.
        if (!this.statuses.has(serverId)) this.statuses.set(serverId, { connected: false, configured: false })
      })
      .finally(() => { this.statusRequests.delete(serverId) })
    this.statusRequests.set(serverId, request)
    return request
  }

  /**
   * Opens the browser sign-in and waits for the host to report the grant.
   * Google must return the browser to the Solus server, which is not the page's
   * own origin: in desktop development the renderer is served by Vite. The
   * host's HTTP origin is the address this client already reaches it at, so
   * the browser can reach it too. Resolves false when the sign-in did not finish.
   */
  async connect(serverId: string): Promise<boolean> {
    if (this.connecting(serverId)) return false
    this.connectingServers.set(serverId, true)
    try {
      const api = serverConnections.apiFor(serverId)
      const flow = await api.googleConnect(serverConnections.httpOriginFor(serverId))
      const opened = await localApi.openExternal(flow.authUrl)
      if (!opened) window.open(flow.authUrl, '_blank', 'noopener,noreferrer')
      const deadline = Math.min(flow.expiresAt, Date.now() + 5 * 60_000)
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        await this.refresh(serverId)
        // A reconnect starts already connected, so waiting on `connected` alone
        // would report success before the wider grant landed.
        if (this.connected(serverId) && !this.needsDriveReadScope(serverId)) return true
      }
      return false
    } finally {
      this.connectingServers.delete(serverId)
    }
  }

  async disconnect(serverId: string): Promise<void> {
    await serverConnections.apiFor(serverId).googleDisconnect()
    const status = this.statuses.get(serverId)
    if (status) this.statuses.set(serverId, { ...status, connected: false, scopes: undefined })
  }
}

export const googleStore = new GoogleStore()
