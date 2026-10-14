import type { AccountState, SignInEnd } from '@solus/contracts/account-types'
import type { DiscoveredServer } from '@solus/contracts/types'
import { SOLUS_CLIENT_IDS, type AccountIdentity } from '@solus/contracts/auth/clients'
import { OAuthSession, type BrowserAuthorizer, type OAuthSessionDeps } from '@solus/client-core/oauth-session'
import { ACTIVE_ORGANIZATION_KEY, OrganizationSelection } from '@solus/client-core/organization-selection'
import type { AgentProfileCloudRequests } from '@solus/client-core/agent-profile-requests'
import type { SettingsCloudRequests } from '@solus/client-core/settings-requests'
import type { SyncAccount } from '@solus/client-core/document-sync'
import { managedHostNeedsStart } from '@solus/client-core/server-registry'
import { organizationIdFor } from '@solus/client-core/uplink-session'
import type { AccountOrganization, DirectoryWorkspace, UplinkEnrollmentTicket } from '@solus/contracts/uplink'
import { Listeners } from '../../lib/listeners'
import type { KeyValueStore, SecretStore } from '../../platform/ports'
import type { HostRegistry, NativeHost } from '../hosts/host-registry'
import { AccountUnauthorizedError, CloudAccountClient } from './account-client'
import { KeychainTokenStore } from './keychain-token-store'

/**
 * The Solus account on this device (docs/adr/0001-standard-authentication.md): one
 * `OAuthSession` as client `solus-mobile`, signed in through the system browser with
 * the authorization code and PKCE. The refresh token lives in the keychain; every
 * cloud call and every host dial uses a five-minute access token for one resource.
 * A directory result is checked against the account generation it started under: a
 * sign-out or a new sign-in makes an older answer stale, and a stale answer is dropped
 * instead of applied. The directory does not depend on the selected organization: a
 * token caller has no active organization, and this device chooses it.
 */

export type AccountView =
  | { kind: 'loading' }
  | { kind: 'signed-out'; message?: string }
  | { kind: 'signing-in' }
  | { kind: 'signed-in'; identity: AccountIdentity; origin: string; isStale: boolean }

export type DirectoryView =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; organizations: AccountOrganization[]; workspaces: DirectoryWorkspace[] }
  | { kind: 'error'; message: string }

const SESSION_ENDED_MESSAGE = 'Your Solus session ended. Sign in again.'

export interface AccountSessionDeps {
  cloudOrigin: string
  registry: HostRegistry
  secrets: SecretStore
  storage: KeyValueStore
  fetch: typeof fetch
  now(): number
  /** The system browser step; absent where the build cannot open one (sign-in then ends in an error). */
  authorizer?: BrowserAuthorizer
  /** Random bytes and SHA-256 where the runtime has no Web Crypto (Hermes). */
  crypto?: Pick<OAuthSessionDeps, 'randomBytes' | 'sha256'>
  /** The Solus hosts on the local network (LAN discovery); absent where the build cannot scan. */
  scanLocalNetwork?: () => Promise<DiscoveredServer[]>
}

export class AccountSession {
  view: AccountView = { kind: 'loading' }
  directory: DirectoryView = { kind: 'idle' }
  readonly changes = new Listeners()
  readonly organizations: OrganizationSelection
  private readonly client: CloudAccountClient
  private readonly tokens: KeychainTokenStore
  private readonly oauth: OAuthSession
  /** The account whose hosts and organizations this device holds now. */
  private identity: AccountIdentity | null = null
  /** Moves when the account on this device changes. */
  private generation = 0
  private loaded: Promise<void> | null = null

  constructor(private readonly deps: AccountSessionDeps) {
    this.client = new CloudAccountClient(deps.cloudOrigin, deps.fetch)
    this.tokens = new KeychainTokenStore(deps.secrets)
    this.oauth = new OAuthSession({
      cloudOrigin: deps.cloudOrigin,
      clientId: SOLUS_CLIENT_IDS.mobile,
      store: this.tokens,
      authorizer: deps.authorizer,
      fetch: deps.fetch,
      now: deps.now,
      ...deps.crypto,
    })
    this.oauth.onChange((state) => {
      if (this.view.kind !== 'loading') this.follow(state)
    })
    const device = {
      getItem: (key: string) => deps.storage.getItem(key),
      setItem: (key: string, value: string) => deps.storage.setItem(key, value),
      removeItem: (key: string) => deps.storage.removeItem(key),
    }
    // A phone has one window: the device choice is the selection.
    this.organizations = new OrganizationSelection(() => ({ window: null, device }))
    this.organizations.subscribe(() => this.changes.notify())
  }

  /** The load barrier for the account. Routes wait for it before restoring. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      await this.tokens.read()
      this.oauth.reload()
      this.follow(this.oauth.state())
    })()
    return this.loaded
  }

  get organizationId(): string | null {
    return this.organizations.organizationId
  }

  get isSignedIn(): boolean {
    return this.identity !== null
  }

  /** Who personal settings sync for: the account and the origin it belongs to. */
  get syncAccount(): SyncAccount | null {
    return this.identity ? { origin: this.deps.cloudOrigin, userId: this.identity.sub } : null
  }

  /** Every keychain write so far has finished. Tests wait on it. */
  written(): Promise<void> {
    return this.tokens.written()
  }

  /** The settings calls, each with a fresh account-plane token. A 401 asks the grant again. */
  settingsRequests(): SettingsCloudRequests {
    return this.client.settingsRequests(() => this.oauth.accessToken({ kind: 'account' }), () => this.recheckGrant())
  }

  /** The agent profile calls (plans/020-agent-profile.md §3), the same way. */
  agentProfileRequests(): AgentProfileCloudRequests {
    return this.client.agentProfileRequests(() => this.oauth.accessToken({ kind: 'account' }), () => this.recheckGrant())
  }

  /** The browser sign-in. A sign-in that does not finish says why, except a cancel. */
  async startSignIn(): Promise<void> {
    const end = await this.oauth.signIn()
    if (end === 'approved') {
      await this.refreshDirectory()
      return
    }
    if (this.view.kind === 'signed-out' && end !== 'cancelled') this.setView({ kind: 'signed-out', message: signInEndMessage(end) })
  }

  cancelSignIn(): void {
    this.oauth.cancelSignIn()
  }

  /** Reads the name, email, and picture again (`/userinfo`), so a change on the website shows here. */
  refreshIdentity(): Promise<void> {
    return this.oauth.refreshIdentity()
  }

  /**
   * Reads organizations and hosts. The two reads are apart: hosts apply even when the
   * account read fails, and then the organizations shown before stay. A result from
   * before a switch or a sign-out is dropped.
   */
  async refreshDirectory(): Promise<void> {
    const identity = this.identity
    if (!identity) return
    const generation = this.generation
    const previous = this.directory
    this.setDirectory({ kind: 'loading' })
    const token = await this.oauth.accessToken({ kind: 'account' })
    if (generation !== this.generation) return
    if (!token) {
      this.setDirectory({ kind: 'error', message: 'Solus Cloud did not answer. Check your connection and try again.' })
      return
    }
    const [account, directory] = await Promise.allSettled([this.client.account(token), this.client.directory(token)])
    if (generation !== this.generation) return
    if (account.status === 'rejected' && account.reason instanceof AccountUnauthorizedError
      || directory.status === 'rejected' && directory.reason instanceof AccountUnauthorizedError) {
      this.recheckGrant()
    }
    if (directory.status === 'rejected') {
      this.setDirectory({ kind: 'error', message: errorText(directory.reason) })
      return
    }
    this.deps.registry.applyDirectory(identity.sub, directory.value.directoryUrl, directory.value.hosts)
    // A registered host that is not linked has no route: look for it on the local network (ADR 0001 §2.2 rule 9).
    if (this.deps.scanLocalNetwork && directory.value.hosts.some((host) => host.routes.length === 0)) {
      void this.deps.scanLocalNetwork().then((found) => this.deps.registry.applyNearby(found)).catch(() => {})
    }
    this.organizations.reconcile(directory.value.workspaces)
    const organizations = account.status === 'fulfilled'
      ? account.value.organizations
      : previous.kind === 'loaded' ? previous.organizations : []
    this.setDirectory({ kind: 'loaded', organizations, workspaces: directory.value.workspaces })
  }

  selectOrganization(organizationId: string): void {
    this.organizations.set(organizationId)
  }

  /** A five-minute access token for one directory host; `fresh` after the host refused the kept one. */
  hostAccessToken(host: NativeHost, options?: { fresh?: boolean }): Promise<string | null> {
    if (!this.identity || !host.uplink) return Promise.resolve(null)
    return this.oauth.accessToken({ kind: 'host', hostId: host.uplink.hostId }, options)
  }

  /**
   * The organization a dial to this host works in (ADR 0001 §6.4): the selected one when
   * the host is shared with it, else the host's first share, else none (the owner).
   */
  dialOrganizationId(host: NativeHost): string | null {
    return organizationIdFor(null, host.uplink, this.organizationId)
  }

  /** Starts a stopped managed host through its existing authorized operation. */
  async startManagedHost(host: NativeHost): Promise<boolean> {
    if (!this.identity || !host.uplink || !managedHostNeedsStart(host.uplink.managedState)) return false
    const token = await this.oauth.accessToken({ kind: 'account' })
    if (!token) return false
    try {
      await this.client.startManagedHost(token, host.uplink.hostId)
      await this.refreshDirectory()
      return true
    } catch (error) {
      if (error instanceof AccountUnauthorizedError) this.recheckGrant()
      return false
    }
  }

  /** Removes a host this account owns from the account, on every device. False when signed out or refused. */
  async removeHost(host: NativeHost): Promise<boolean> {
    if (!this.identity || !host.uplink) return false
    const token = await this.oauth.accessToken({ kind: 'account' })
    if (!token) return false
    try {
      await this.client.removeHost(token, host.uplink.hostId)
      await this.refreshDirectory()
      return true
    } catch (error) {
      if (error instanceof AccountUnauthorizedError) this.recheckGrant()
      return false
    }
  }

  /** A ticket to link a host to this account; null when signed out. */
  async issueEnrollmentTicket(): Promise<UplinkEnrollmentTicket | null> {
    if (!this.identity) return null
    const token = await this.oauth.accessToken({ kind: 'account' })
    if (!token) return null
    try {
      return await this.client.enrollmentTicket(token)
    } catch (error) {
      if (error instanceof AccountUnauthorizedError) this.recheckGrant()
      throw error
    }
  }

  /** Cloud sign-out: revokes this device's grant; cloud state leaves; directly paired hosts stay. */
  async signOut(): Promise<void> {
    await this.oauth.signOut()
  }

  /** The account plane refused a token: a refresh tells whether the grant still lives. */
  private recheckGrant(): void {
    void this.oauth.accessToken({ kind: 'account' }, { fresh: true })
  }

  private follow(state: AccountState): void {
    switch (state.kind) {
      case 'signed-in':
        if (this.identity?.sub !== state.identity.sub) {
          if (this.identity) this.endAccount()
          this.generation += 1
        }
        this.identity = state.identity
        this.setView({ kind: 'signed-in', identity: state.identity, origin: state.consoleUrl, isStale: state.isStale })
        return
      case 'signing-in':
        this.setView({ kind: 'signing-in' })
        return
      case 'invalid':
        if (this.identity) {
          this.endAccount()
          this.setView({ kind: 'signed-out', message: SESSION_ENDED_MESSAGE })
          return
        }
        this.setView({ kind: 'signed-out', message: state.reason === 'unreachable' ? signInEndMessage('error') : SESSION_ENDED_MESSAGE })
        return
      case 'signed-out':
      case 'unavailable':
        if (this.identity) this.endAccount()
        this.setView({ kind: 'signed-out' })
    }
  }

  /** The account's hosts, organization choice, and directory leave this device. */
  private endAccount(): void {
    const identity = this.identity
    this.generation += 1
    this.identity = null
    if (identity) this.deps.registry.forgetAccount(identity.sub)
    // No workspaces: the selection empties, and the device seed goes with the account.
    this.organizations.reconcile([])
    this.deps.storage.removeItem(ACTIVE_ORGANIZATION_KEY)
    this.setDirectory({ kind: 'idle' })
  }

  private setView(view: AccountView): void {
    this.view = view
    this.changes.notify()
  }

  private setDirectory(directory: DirectoryView): void {
    this.directory = directory
    this.changes.notify()
  }
}

function signInEndMessage(end: Exclude<SignInEnd, 'approved' | 'cancelled'>): string {
  if (end === 'denied') return 'The sign-in was denied in the browser.'
  return 'Sign-in did not finish. Check your connection and try again.'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
