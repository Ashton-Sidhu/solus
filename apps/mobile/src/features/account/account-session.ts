import { z } from 'zod'
import { HostGrantCache, type GrantOptions } from '@solus/client-core/host-grant-cache'
import { formatUserCode, requestDeviceCode, waitForDeviceApproval } from '@solus/client-core/device-authorization'
import { ACTIVE_ORGANIZATION_KEY, OrganizationSelection } from '@solus/client-core/organization-selection'
import type { SettingsCloudRequests } from '@solus/client-core/settings-requests'
import type { SyncAccount } from '@solus/client-core/settings-sync'
import { managedHostNeedsStart } from '@solus/client-core/server-registry'
import type { AccountProfile } from '@solus/contracts/account-types'
import type { AccountOrganization, DirectoryWorkspace } from '@solus/contracts/uplink'
import { Listeners } from '../../lib/listeners'
import type { KeyValueStore, SecretStore } from '../../platform/ports'
import type { HostRegistry, NativeHost } from '../hosts/host-registry'
import { AccountUnauthorizedError, MOBILE_DEVICE_CLIENT_ID, type CloudAccountClient } from './account-client'

/**
 * The Solus account on this device (plan 017 stages 1–2). The session token is
 * the only cloud credential and lives in the keychain. Every account result is
 * checked against the generation it started under: a sign-out, a new sign-in,
 * or an organization switch makes an older answer stale, and a stale answer is
 * dropped instead of applied.
 */

export type AccountView =
  | { kind: 'loading' }
  | { kind: 'signed-out'; message?: string }
  | { kind: 'signing-in'; userCode: string; verificationUrl: string; expiresAt: number }
  | { kind: 'signed-in'; profile: AccountProfile; origin: string }

export type DirectoryView =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; organizations: AccountOrganization[]; workspaces: DirectoryWorkspace[] }
  | { kind: 'error'; message: string }

const SESSION_KEY = 'solus.mobile.account'
const storedSessionSchema = z.object({
  sessionToken: z.string().min(1),
  origin: z.string().min(1),
  profile: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    avatarUrl: z.string().nullable(),
  }),
})
type StoredSession = z.infer<typeof storedSessionSchema>
/** The keychain value: JSON text of a stored session. Unreadable text is no session. */
const storedSessionJsonSchema = z.string().transform((text, context) => {
  try {
    return JSON.parse(text)
  } catch {
    context.addIssue({ code: 'custom', message: 'not JSON' })
    return z.NEVER
  }
}).pipe(storedSessionSchema)

export interface AccountSessionDeps {
  client: CloudAccountClient
  registry: HostRegistry
  secrets: SecretStore
  storage: KeyValueStore
  fetch: typeof fetch
  now(): number
  sleep(ms: number, signal: AbortSignal): Promise<void>
  /** Opens the approval page in the system browser. */
  openBrowser(url: string): Promise<void>
  deviceLabel: string
}

export class AccountSession {
  view: AccountView = { kind: 'loading' }
  directory: DirectoryView = { kind: 'idle' }
  readonly changes = new Listeners()
  readonly organizations: OrganizationSelection
  private stored: StoredSession | null = null
  private generation = 0
  private signIn: AbortController | null = null
  private loaded: Promise<void> | null = null
  private readonly grants: HostGrantCache

  constructor(private readonly deps: AccountSessionDeps) {
    this.grants = new HostGrantCache(deps.now)
    deps.registry.onHostRemoved(() => this.grants.clear())
    const device = {
      getItem: (key: string) => deps.storage.getItem(key),
      setItem: (key: string, value: string) => deps.storage.setItem(key, value),
      removeItem: (key: string) => deps.storage.removeItem(key),
    }
    // A phone has one window: the device choice is the selection.
    this.organizations = new OrganizationSelection(() => ({ window: null, device }))
    this.organizations.subscribe(() => {
      this.generation += 1
      this.changes.notify()
    })
  }

  /** The load barrier for the account. Routes wait for it before restoring. */
  load(): Promise<void> {
    this.loaded ??= this.readStored()
    return this.loaded
  }

  private async readStored(): Promise<void> {
    const raw = await this.deps.secrets.get(SESSION_KEY)
    const decoded = raw ? storedSessionJsonSchema.safeParse(raw) : null
    if (decoded?.success) {
      this.stored = decoded.data
      this.setView({ kind: 'signed-in', profile: decoded.data.profile, origin: decoded.data.origin })
    } else {
      if (raw) await this.deps.secrets.delete(SESSION_KEY)
      this.setView({ kind: 'signed-out' })
    }
  }

  get organizationId(): string | null {
    return this.organizations.organizationId
  }

  get isSignedIn(): boolean {
    return this.stored !== null
  }

  /** Who personal settings sync for: the account and the origin it belongs to. */
  get syncAccount(): SyncAccount | null {
    return this.stored ? { origin: this.stored.origin, userId: this.stored.profile.id } : null
  }

  /**
   * The settings calls for whoever is signed in when each is made. The token
   * stays here; a 401 ends the session, as it does for every account call.
   */
  settingsRequests(): SettingsCloudRequests {
    return this.deps.client.settingsRequests(
      () => this.stored?.sessionToken ?? null,
      (refused) => {
        // Only the session that was refused ends; a newer sign-in stays.
        if (this.stored?.sessionToken === refused) void this.endSession('Your Solus session ended. Sign in again.')
      },
    )
  }

  /** Starts device sign-in and opens the approval page. Cancel with `cancelSignIn`. */
  async startSignIn(): Promise<void> {
    this.cancelSignIn()
    const generation = ++this.generation
    const controller = new AbortController()
    this.signIn = controller
    const { client } = this.deps
    let grant: Awaited<ReturnType<typeof requestDeviceCode>>
    try {
      grant = await requestDeviceCode({ cloudOrigin: client.origin, clientId: MOBILE_DEVICE_CLIENT_ID, fetch: this.deps.fetch, now: this.deps.now })
    } catch (error) {
      if (generation === this.generation) {
        this.signIn = null
        this.setView({ kind: 'signed-out', message: signInRefusalMessage(error instanceof Error ? error.message : String(error)) })
      }
      return
    }
    if (generation !== this.generation) return
    this.setView({ kind: 'signing-in', userCode: formatUserCode(grant.userCode), verificationUrl: grant.verificationUrl, expiresAt: grant.expiresAt })
    void this.deps.openBrowser(grant.verificationUrl).catch(() => undefined)

    // The poll keeps its own clock: a suspended app resumes the same wait, and
    // an expired code ends it instead of leaving a spinner.
    const result = await waitForDeviceApproval(grant, { cloudOrigin: client.origin, fetch: this.deps.fetch, now: this.deps.now, sleep: this.deps.sleep }, controller.signal)
    if (generation !== this.generation) return
    this.signIn = null
    if (result.end !== 'approved') {
      this.setView({ kind: 'signed-out', message: result.end === 'cancelled' ? undefined : result.message })
      return
    }
    try {
      const profile = await client.me(result.sessionToken)
      if (generation !== this.generation) return
      const stored: StoredSession = { sessionToken: result.sessionToken, origin: client.origin, profile }
      await this.deps.secrets.set(SESSION_KEY, JSON.stringify(stored))
      if (generation !== this.generation) return
      this.stored = stored
      this.grants.clear()
      this.setView({ kind: 'signed-in', profile, origin: client.origin })
      void client.nameDevice(result.sessionToken, this.deps.deviceLabel).catch(() => undefined)
      await this.refreshDirectory()
    } catch {
      if (generation === this.generation) this.setView({ kind: 'signed-out', message: 'Signed in, but the account could not be read. Try again.' })
    }
  }

  cancelSignIn(): void {
    if (!this.signIn) return
    this.signIn.abort()
    this.signIn = null
    this.generation += 1
    if (this.view.kind === 'signing-in') this.setView({ kind: 'signed-out' })
  }

  /** Reads organizations and hosts. A result from before a switch is dropped. */
  async refreshDirectory(): Promise<void> {
    const stored = this.stored
    if (!stored) return
    const generation = this.generation
    this.setDirectory({ kind: 'loading' })
    try {
      const [account, directory] = await Promise.all([
        this.deps.client.account(stored.sessionToken),
        this.deps.client.directory(stored.sessionToken),
      ])
      if (generation !== this.generation || this.stored !== stored) return
      this.deps.registry.applyDirectory(stored.profile.id, directory.directoryUrl, directory.hosts)
      this.organizations.reconcile(directory.workspaces)
      // Reconciling may move the generation; the read itself is still current.
      this.setDirectory({ kind: 'loaded', organizations: account.organizations, workspaces: directory.workspaces })
    } catch (error) {
      if (this.stored !== stored) return
      if (error instanceof AccountUnauthorizedError) {
        await this.endSession('Your Solus session ended. Sign in again.')
        return
      }
      if (generation === this.generation) this.setDirectory({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  selectOrganization(organizationId: string): void {
    this.organizations.set(organizationId)
  }

  /** Reuse an eight-hour grant for this host and organization; renew on refusal. */
  async acquireHostAccessToken(host: NativeHost, options?: GrantOptions): Promise<string | null> {
    const stored = this.stored
    if (!stored || !host.uplink) return null
    const hostId = host.uplink.hostId
    const selectedOrganization = this.organizationId
    const organizationId = selectedOrganization && host.uplink.organizationIds?.includes(selectedOrganization)
      ? selectedOrganization
      : null
    try {
      const grant = await this.grants.acquire(hostId, organizationId ?? undefined,
        () => this.deps.client.hostAccessToken(stored.sessionToken, hostId, organizationId), options)
      return this.stored === stored && this.organizationId === selectedOrganization ? grant?.accessToken ?? null : null
    } catch (error) {
      if (error instanceof AccountUnauthorizedError && this.stored === stored) await this.endSession('Your Solus session ended. Sign in again.')
      return null
    }
  }

  /** Starts a stopped managed host through its existing authorized operation. */
  async startManagedHost(host: NativeHost): Promise<boolean> {
    const stored = this.stored
    if (!stored || !host.uplink || !managedHostNeedsStart(host.uplink.managedState)) return false
    try {
      await this.deps.client.startManagedHost(stored.sessionToken, host.uplink.hostId)
      await this.refreshDirectory()
      return true
    } catch {
      return false
    }
  }

  /** Cloud sign-out: cloud state leaves; directly paired hosts stay. */
  async signOut(): Promise<void> {
    const stored = this.stored
    this.cancelSignIn()
    const ended = this.endSession()
    if (stored) await this.deps.client.signOut(stored.sessionToken)
    await ended
  }

  private async endSession(message?: string): Promise<void> {
    const stored = this.stored
    this.generation += 1
    this.stored = null
    this.grants.clear()
    await this.deps.secrets.delete(SESSION_KEY)
    if (stored) this.deps.registry.forgetAccount(stored.profile.id)
    // No workspaces: the selection empties, and the device seed goes with the account.
    this.organizations.reconcile([])
    this.deps.storage.removeItem(ACTIVE_ORGANIZATION_KEY)
    this.setDirectory({ kind: 'idle' })
    this.setView({ kind: 'signed-out', message })
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

/** The device-code request is refused while Solus Cloud does not list this
 *  app's client id; say so instead of a generic failure. */
function signInRefusalMessage(text: string): string {
  if (/\(400\)|\(401\)|\(403\)/.test(text)) return 'Solus Cloud does not accept sign-in from this app yet.'
  return 'Solus Cloud did not answer. Check your connection and try again.'
}
