import type { AccountState, SignInEnd } from '@solus/contracts/account-types'
import type { DiscoveredServer } from '@solus/contracts/types'
import { SOLUS_CLIENT_IDS, type AccountIdentity } from '@solus/contracts/auth/clients'
import { OAuthSession, type BrowserAuthorizer, type OAuthSessionDeps } from '@solus/client-core/oauth-session'
import { ACTIVE_ORGANIZATION_KEY, OrganizationSelection } from '@solus/client-core/organization-selection'
import type { AgentProfileCloudRequests } from '@solus/client-core/agent-profile-requests'
import type { SettingsCloudRequests } from '@solus/client-core/settings-requests'
import type { SyncAccount } from '@solus/client-core/document-sync'
import { managedHostNeedsStart, type KnownHost } from '@solus/client-core/known-host'
import type { HostDirectoryReader } from '@solus/client-core/host-catalog'
import { hostListSourceFor } from '@solus/client-core/host-list-source'
import { organizationIdFor } from '@solus/client-core/uplink-session'
import type { AccountOrganization, DirectoryWorkspace, UplinkDirectory, UplinkEnrollmentTicket } from '@solus/contracts/uplink'
import { cloudUnreachableText, parseCloudAddress, type CloudAddressChange, type CloudAddressState } from '@solus/contracts/cloud-address'
import { Listeners } from '../../lib/listeners'
import type { KeyValueStore, SecretStore } from '../../platform/ports'
import type { HostRegistry } from '../hosts/host-registry'
import { AccountUnauthorizedError, CloudAccountClient } from './account-client'
import { KeychainTokenStore } from './keychain-token-store'

/**
 * The Solus account on this device (docs/adr/0001-standard-authentication.md): one
 * `OAuthSession` as client `solus-mobile`, signed in through the system browser with
 * the authorization code and PKCE. The refresh token lives in the keychain; every
 * cloud call uses the token for our servers, and every host dial that host's token.
 * A directory result is checked against the account generation it started under: a
 * sign-out or a new sign-in makes an older answer stale, and a stale answer is dropped
 * instead of applied. The directory does not depend on the selected organization: a
 * token caller has no active organization, and this device chooses it.
 *
 * It is the host catalog's directory reader, and it chooses where the catalog reads
 * the person's host list (plans/033 §4.3): the account while signed in; device
 * storage while signed out, because a phone has no host of its own.
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
/** The Solus Cloud address the person chose for this device (docs/solus-cloud-address.md); absent for the default. */
export const CLOUD_ADDRESS_KEY = 'solus.mobile.cloudAddress'

export interface AccountSessionDeps {
  /** The default Solus Cloud address; the person's choice in device storage comes first. */
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

export class AccountSession implements HostDirectoryReader {
  view: AccountView = { kind: 'loading' }
  directory: DirectoryView = { kind: 'idle' }
  /** The Solus Cloud address this device signs in to, and whether the person chose it. */
  cloudAddress: CloudAddressState
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
  /** The account whose host list the catalog reads; null is the list on this device, undefined is none chosen yet. */
  private hostListAccount: string | null | undefined = undefined
  /** Why the last directory read failed; null when it did not. */
  private directoryError: string | null = null
  /** The first read of the host list that the last sign-in or sign-out started. A start waits for it to know whether there are hosts. */
  hostListRead: Promise<void> = Promise.resolve()

  constructor(private readonly deps: AccountSessionDeps) {
    const chosen = parseCloudAddress(deps.storage.getItem(CLOUD_ADDRESS_KEY) ?? '')
    const cloudOrigin = chosen.ok ? chosen.origin : deps.cloudOrigin
    this.cloudAddress = this.addressOf(cloudOrigin)
    this.client = new CloudAccountClient(cloudOrigin, deps.fetch)
    this.tokens = new KeychainTokenStore(deps.secrets)
    this.oauth = new OAuthSession({
      cloudOrigin,
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
    return this.identity ? { origin: this.oauth.cloudOrigin, userId: this.identity.sub } : null
  }

  /**
   * Changes the address; `null` goes back to the default. Only while signed out: each
   * token belongs to the address that issued it (`OAuthSession.useCloudOrigin`). The
   * choice stays in device storage. No host receives it.
   */
  setCloudAddress(input: string | null): CloudAddressChange {
    let origin = this.deps.cloudOrigin
    if (input !== null) {
      const parsed = parseCloudAddress(input)
      if (!parsed.ok) return parsed
      origin = parsed.origin
    }
    if (!this.oauth.useCloudOrigin(origin)) return { ok: false, refusal: 'signed-in' }
    this.client.origin = origin
    if (origin === this.deps.cloudOrigin) this.deps.storage.removeItem(CLOUD_ADDRESS_KEY)
    else this.deps.storage.setItem(CLOUD_ADDRESS_KEY, origin)
    this.cloudAddress = this.addressOf(origin)
    this.changes.notify()
    return { ok: true, address: this.cloudAddress }
  }

  private addressOf(origin: string): CloudAddressState {
    return { origin, source: origin === this.deps.cloudOrigin ? 'default' : 'setting' }
  }

  /** Every keychain write so far has finished. Tests wait on it. */
  written(): Promise<void> {
    return this.tokens.written()
  }

  /** The settings calls, each with a fresh account-plane token. A 401 asks the grant again. */
  settingsRequests(): SettingsCloudRequests {
    return this.client.settingsRequests(() => this.oauth.accessToken({ kind: 'account' }), () => this.recheckGrant(), () => this.oauth.takeStartupSettings())
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
    // Solus Cloud did not answer at this address: `followState` said so, with the address.
    const state = this.oauth.state()
    if (state.kind === 'invalid' && state.reason === 'unreachable') return
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
   * account read fails, and then the organizations shown before stay. The host catalog
   * reads the directory (`listDirectory`) and keeps its hosts and workspace services.
   * A result from before a switch or a sign-out is dropped.
   */
  async refreshDirectory(): Promise<void> {
    if (!this.identity) return
    const generation = this.generation
    const previous = this.directory
    this.setDirectory({ kind: 'loading' })
    const [account] = await Promise.allSettled([this.readAccount(), this.deps.registry.refreshDirectory()])
    if (generation !== this.generation) return
    if (account.status === 'rejected' && account.reason instanceof AccountUnauthorizedError) this.recheckGrant()
    if (this.directoryError) {
      this.setDirectory({ kind: 'error', message: this.directoryError })
      return
    }
    // A registered host that is not linked has no route: look for it on the local network (ADR 0001 §2.2 rule 9).
    if (this.deps.scanLocalNetwork && this.deps.registry.hosts().some((host) => host.uplink && host.routes.length === 0)) {
      void this.deps.scanLocalNetwork().then((found) => this.deps.registry.applyNearby(found)).catch(() => {})
    }
    const workspaces = [...this.deps.registry.workspaces()]
    this.organizations.reconcile(workspaces)
    const organizations = account.status === 'fulfilled'
      ? account.value.organizations
      : previous.kind === 'loaded' ? previous.organizations : []
    this.setDirectory({ kind: 'loaded', organizations, workspaces })
  }

  /**
   * The account's directory, for the host catalog. A read that a sign-out or another
   * account overtook is read again for the account on this device now, so the catalog
   * never keeps another account's hosts. Null when signed out or the read failed.
   */
  async listDirectory(): Promise<UplinkDirectory | null> {
    for (;;) {
      const generation = this.generation
      this.directoryError = null
      if (!this.identity) return null
      try {
        const directory = await this.readDirectory()
        if (generation === this.generation) return directory
      } catch (error) {
        if (generation !== this.generation) continue
        if (error instanceof AccountUnauthorizedError) this.recheckGrant()
        this.directoryError = errorText(error)
        return null
      }
    }
  }

  private async readDirectory(): Promise<UplinkDirectory> {
    const token = await this.oauth.accessToken({ kind: 'account' })
    if (!token) throw new Error('Solus Cloud did not answer. Check your connection and try again.')
    const startup = this.oauth.takeStartupDirectory()
    return startup ? { directoryUrl: this.client.origin, ...startup } : this.client.directory(token)
  }

  private async readAccount() {
    const token = await this.oauth.accessToken({ kind: 'account' })
    if (!token) throw new Error('Solus Cloud did not answer. Check your connection and try again.')
    return this.oauth.takeStartupAccount() ?? this.client.account(token)
  }

  selectOrganization(organizationId: string): void {
    this.organizations.set(organizationId)
  }

  /** An access token for one directory host; `refused` names a kept one the host refused. */
  hostAccessToken(host: KnownHost, options?: { refused?: string }): Promise<string | null> {
    if (!this.identity || !host.uplink) return Promise.resolve(null)
    return this.oauth.accessToken({ kind: 'host', hostId: host.uplink.hostId }, options)
  }

  /** An access token for an organization's Solus API; null when signed out. */
  solusApiAccessToken(options?: { refused?: string }): Promise<string | null> {
    if (!this.identity) return Promise.resolve(null)
    return this.oauth.accessToken({ kind: 'api' }, options)
  }

  /** The routes the directory lists for an organization's Solus API; empty when it lists none. */
  solusApiRoutes(organizationId: string): DirectoryWorkspace['routes'] {
    return this.deps.registry.workspaces().find((workspace) => workspace.organizationId === organizationId)?.routes ?? []
  }

  /**
   * Whether an organization saves the conversations of its sessions in Solus
   * Cloud, as the directory last said (`DirectoryWorkspace.sessionCloudSync`).
   * True when the directory does not list the organization or does not say:
   * only a known `false` makes the machines the one source of these sessions
   * (client-core `session-home.ts`).
   */
  savesSessionsToCloud(organizationId: string): boolean {
    return this.deps.registry.workspaces().find((workspace) => workspace.organizationId === organizationId)?.sessionCloudSync !== false
  }

  /** True when the phone holds no sign-in: it ended or was never made. */
  isSignedOut(): boolean {
    return !this.identity
  }

  /**
   * The organization a dial to this host works in (ADR 0001 §6.4): the selected one when
   * the host is shared with it, else the host's first share, else none (the owner).
   */
  dialOrganizationId(host: KnownHost): string | null {
    return organizationIdFor(null, host.uplink, this.organizationId)
  }

  /** Starts a stopped managed host through its existing authorized operation. */
  async startManagedHost(host: KnownHost): Promise<boolean> {
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
  async removeHost(host: KnownHost): Promise<boolean> {
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

  /** The account plane refused its token: a refresh tells whether the grant still lives. */
  private recheckGrant(): void {
    void this.oauth.accessToken({ kind: 'account' }).then((refused) => {
      if (refused) void this.oauth.accessToken({ kind: 'account' }, { refused })
    })
  }

  private follow(state: AccountState): void {
    this.followState(state)
    this.followHostList()
  }

  private followState(state: AccountState): void {
    switch (state.kind) {
      case 'signed-in':
        if (this.identity?.sub !== state.identity.sub) {
          if (this.identity) this.endAccount()
          this.generation += 1
          // Paired hosts can load before cloud: keep their organization sessions
          // visible until the directory can reconcile this device's saved choice.
          const organizationId = this.deps.storage.getItem(ACTIVE_ORGANIZATION_KEY)
          if (organizationId) this.organizations.set(organizationId)
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
        this.setView({ kind: 'signed-out', message: state.reason === 'unreachable' ? cloudUnreachableText(this.oauth.cloudOrigin) : SESSION_ENDED_MESSAGE })
        return
      case 'signed-out':
      case 'unavailable':
        if (this.identity) this.endAccount()
        this.setView({ kind: 'signed-out' })
    }
  }

  /**
   * The catalog reads the account's host list while signed in, and the list on this
   * device while signed out (plans/033 §2). The credentials stay either way, and the
   * catalog moves the hosts this phone paired to the new list. Signed out, the
   * directory answers no hosts, so the account's hosts leave.
   */
  private followHostList(): void {
    const account = this.identity?.sub ?? null
    if (account === this.hostListAccount) return
    this.hostListAccount = account
    const accountDocuments = this.identity
      ? this.client.accountDocuments(() => this.oauth.accessToken({ kind: 'account' }), () => this.recheckGrant())
      : null
    this.hostListRead = this.deps.registry.useListSource(hostListSourceFor({ accountDocuments, deviceHost: null, deviceStorage: this.deps.storage }))
    // A directory read in flight is shared, and it may answer for the account that left: read again after it.
    if (!account) void this.deps.registry.refreshDirectory().then(() => this.deps.registry.refreshDirectory())
  }

  /** The account's organization choice and directory leave this device; the catalog drops its hosts (`followHostList`). */
  private endAccount(): void {
    this.generation += 1
    this.identity = null
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
