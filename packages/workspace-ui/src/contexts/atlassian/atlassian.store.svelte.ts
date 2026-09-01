import type { AtlassianJiraProject, AtlassianProduct, AtlassianStatus } from '@solus/contracts/atlassian'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { localApi } from '@solus/client-core/local-api'
import { SvelteMap } from 'svelte/reactivity'

/**
 * The one place the renderer knows anything about the Atlassian site connection.
 *
 * No credential ever lands here. The browser sign-in happens on the host, and
 * what survives is only what the host reports back — the site, the products the
 * grant reaches, and whether this build can sign in at all.
 */

export interface AtlassianConnectFailure {
  message: string
}

export const ATLASSIAN_SIGNUP_URL = 'https://www.atlassian.com/software/jira/free'

const PRODUCT_LABELS = {
  confluence: 'Confluence',
  jira: 'Jira',
} satisfies Record<AtlassianProduct, string>

export class AtlassianStore {
  private statuses = new SvelteMap<string, AtlassianStatus>()
  private loadedServers = new SvelteMap<string, boolean>()
  private connectingServers = new SvelteMap<string, boolean>()
  /** Browser sign-ins which are open and whose callback has not landed yet. */
  private awaitingBrowserServers = new SvelteMap<string, boolean>()
  private failures = new SvelteMap<string, AtlassianConnectFailure>()
  private statusRequests = new Map<string, Promise<void>>()
  private statusGenerations = new Map<string, number>()

  status(serverId: string | null | undefined): AtlassianStatus | null {
    return serverId ? (this.statuses.get(serverId) ?? null) : null
  }

  statusLoaded(serverId: string | null | undefined): boolean {
    return serverId ? this.loadedServers.get(serverId) === true : false
  }

  connected(serverId: string | null | undefined): boolean {
    return this.status(serverId)?.connected === true
  }

  /** Whether this build ships an OAuth client. When it does not there is no way
   *  to connect, and the UI says so rather than offering a button that fails. */
  oauthAvailable(serverId: string | null | undefined): boolean {
    return this.status(serverId)?.oauthAvailable === true
  }

  /** The site's hostname — what a user recognizes, without the scheme noise. */
  siteName(serverId: string | null | undefined): string {
    const status = this.status(serverId)
    return status?.siteName || (status?.siteUrl ?? '').replace(/^https:\/\//, '')
  }

  /** "Confluence and Jira", or the single product the grant reaches. */
  productSummary(serverId: string | null | undefined): string {
    const labels = (this.status(serverId)?.products ?? []).map((product) => PRODUCT_LABELS[product])
    if (labels.length === 0) return 'No products'
    if (labels.length === 1) return labels[0]!
    return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`
  }

  /** First caller pays for the fetch; everyone after reads the cached status. */
  ensureStatus(serverId: string): Promise<void> {
    if (this.statusLoaded(serverId)) return Promise.resolve()
    const pending = this.statusRequests.get(serverId)
    if (pending) return pending
    const request = this.loadStatus(serverId)
    this.statusRequests.set(serverId, request)
    return request
  }

  async refreshStatus(serverId: string): Promise<void> {
    const request = this.loadStatus(serverId)
    this.statusRequests.set(serverId, request)
    await request
  }

  private async loadStatus(serverId: string): Promise<void> {
    const generation = (this.statusGenerations.get(serverId) ?? 0) + 1
    this.statusGenerations.set(serverId, generation)
    this.loadedServers.set(serverId, false)
    try {
      const status = await serverConnections.apiFor(serverId).atlassianStatus()
      if (generation === this.statusGenerations.get(serverId)) this.statuses.set(serverId, status)
    } catch (e) {
      console.error('atlassianStatus failed', e)
    } finally {
      if (generation === this.statusGenerations.get(serverId)) {
        this.loadedServers.set(serverId, true)
        this.statusRequests.delete(serverId)
      }
    }
  }

  connecting(serverId: string | null | undefined): boolean {
    return serverId ? this.connectingServers.get(serverId) === true : false
  }

  awaitingBrowser(serverId: string | null | undefined): boolean {
    return serverId ? this.awaitingBrowserServers.get(serverId) === true : false
  }

  failure(serverId: string | null | undefined): AtlassianConnectFailure | null {
    return serverId ? (this.failures.get(serverId) ?? null) : null
  }

  /**
   * Opens the browser sign-in. Resolves as soon as the browser is open, not
   * when the grant lands — the callback arrives on the host, which broadcasts
   * `atlassian.oauthCompleted`, so the waiting is event-driven rather than a
   * promise nobody can cancel.
   */
  async startOAuth(serverId: string): Promise<boolean> {
    if (this.connecting(serverId)) return false
    this.connectingServers.set(serverId, true)
    this.failures.delete(serverId)
    try {
      const result = await serverConnections.apiFor(serverId).atlassianStartOAuth()
      if (!result.ok) {
        this.failures.set(serverId, { message: result.error })
        return false
      }
      this.awaitingBrowserServers.set(serverId, true)
      await localApi.openExternal(result.authUrl)
      return true
    } catch (e) {
      console.error('atlassianStartOAuth failed', e)
      this.failures.set(serverId, { message: 'Could not start the Atlassian sign-in.' })
      return false
    } finally {
      this.connectingServers.set(serverId, false)
    }
  }

  /**
   * Gives up on a browser flow the user abandoned. This has to reach the host:
   * the sign-in holds a fixed loopback port while it waits, and leaving it bound
   * would block the next attempt.
   */
  async cancelBrowserWait(serverId: string): Promise<void> {
    this.awaitingBrowserServers.set(serverId, false)
    try {
      await serverConnections.apiFor(serverId).atlassianCancelOAuth()
    } catch (e) {
      console.error('atlassianCancelOAuth failed', e)
    }
  }

  async disconnect(serverId: string): Promise<void> {
    try {
      await serverConnections.apiFor(serverId).atlassianDisconnect()
      this.failures.delete(serverId)
      // The projects belonged to the site that just went away.
      this.jiraProjectsByServer.delete(serverId)
      await this.refreshStatus(serverId)
    } catch (e) {
      console.error('atlassianDisconnect failed', e)
    }
  }

  clearFailure(serverId: string): void {
    this.failures.delete(serverId)
  }

  /**
   * The Jira projects a task binding can point at, per host.
   *
   * Kept beside the connection rather than in the tasks store because that is
   * what decides them: the list belongs to the connected site, and disconnecting
   * must empty it. Loaded on demand — nothing needs it until someone opens the
   * task-provider picker.
   */
  jiraProjectsByServer = new SvelteMap<string, AtlassianJiraProject[]>()
  private jiraProjectsLoadingByServer = new SvelteMap<string, boolean>()
  private jiraProjectsErrors = new SvelteMap<string, string>()

  jiraProjects(serverId: string | null | undefined): AtlassianJiraProject[] {
    return serverId ? (this.jiraProjectsByServer.get(serverId) ?? []) : []
  }

  jiraProjectsLoading(serverId: string | null | undefined): boolean {
    return serverId ? this.jiraProjectsLoadingByServer.get(serverId) === true : false
  }

  jiraProjectsError(serverId: string | null | undefined): string | null {
    return serverId ? (this.jiraProjectsErrors.get(serverId) ?? null) : null
  }

  async loadJiraProjects(serverId: string): Promise<void> {
    if (this.jiraProjectsLoading(serverId)) return
    this.jiraProjectsLoadingByServer.set(serverId, true)
    this.jiraProjectsErrors.delete(serverId)
    try {
      this.jiraProjectsByServer.set(
        serverId,
        await serverConnections.apiFor(serverId).atlassianJiraProjects(),
      )
    } catch (e) {
      console.error('atlassianJiraProjects failed', e)
      this.jiraProjectsErrors.set(serverId, e instanceof Error ? e.message : String(e))
      // The status this client holds was read before the call and may now be
      // stale: a grant the host found dead is dropped there, and every surface
      // that still says "connected" is lying until it re-reads.
      void this.refreshStatus(serverId)
    } finally {
      this.jiraProjectsLoadingByServer.set(serverId, false)
    }
  }

  /** Called once at boot. The tab that started a sign-in may not be the one in
   *  front when it finishes, so every client listens. */
  listenForOAuthCompletion(): () => void {
    return subscribeAllHosts('atlassian.oauthCompleted', (serverId, event) => {
      this.awaitingBrowserServers.set(serverId, false)
      if (event.connected) {
        this.failures.delete(serverId)
        void this.refreshStatus(serverId)
        return
      }
      if (event.error) this.failures.set(serverId, { message: event.error })
    })
  }
}

export const atlassianStore = new AtlassianStore()
