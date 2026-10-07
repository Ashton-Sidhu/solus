import { z } from 'zod'
import { SendOutbox } from '@solus/client-core/send-outbox'
import { pairServer, urlHost } from '@solus/client-core/pairing'
import type { WsTransportOptions } from '@solus/client-core/ws-transport'
import { replaceModelProfiles, type AgentId, type SessionRecord } from '@solus/contracts/types'
import type { HostApi } from '@solus/client-core/host-api'
import { OrganizationSettingsClient, settingsAccountKey, type SettingsSyncEnvironment } from '@solus/client-core/settings-sync'
import { CloudAccountClient, DEFAULT_CLOUD_ORIGIN } from '../features/account/account-client'
import { AccountSession } from '../features/account/account-session'
import { conversationOutboxPrefix, type ConversationTarget } from '../features/conversation/conversation-controller'
import type { AttachmentIo } from '../features/conversation/lib/attachments'
import { ConversationStore } from '../features/conversation/conversation-store'
import type { RunSettings } from '../features/conversation/lib/ipc-context'
import { HostConnections, type HostTransport } from '../features/hosts/host-connections'
import { KeyboardCommands } from '../features/keyboard/keyboard-commands'
import { HostRegistry, type NativeHost } from '../features/hosts/host-registry'
import { previewHost, type HostPreview, type PreviewResult } from '../features/hosts/lib/pair-input'
import { ThreadDirectory } from '../features/threads/thread-directory'
import { ThreadListState } from '../features/threads/thread-list-state'
import { NativeNotificationHub } from '../features/notifications/notification-hub'
import { AppearancePreference, type AppearanceMode } from '../features/settings/appearance'
import { HostSettings } from '../features/settings/host-settings'
import { HostCloudLink } from '../features/settings/host-cloud-link'
import { HostAccess } from '../features/settings/host-access'
import { LiveActivityPreference } from '../features/live-activity/live-activity-preference'
import { PersonalSettingsStore } from '../features/settings/personal-settings'
import { alwaysOnlineEnvironment, PersonalSync, timerClock } from '../features/settings/personal-sync'
import { OrganizationSettingsStore } from '../features/settings/organization-settings'
import { PullRequestDirectory } from '../features/prs/pull-request-directory'
import { ProjectFiles } from '../features/files/project-files'
import { removeKeysWithPrefix, type KeyValueStore, type SecretStore } from '../platform/ports'

/**
 * The native client's composition root: one registry, one connection owner,
 * one account, and the conversations open on this device. The Expo adapters
 * are passed in, so the same object runs under test.
 */

export interface PlatformAdapters {
  storage: KeyValueStore
  secrets: SecretStore
  fetch: typeof fetch
  createTransport(options: WsTransportOptions): HostTransport
  openBrowser(url: string): Promise<void>
  /** What this device calls itself to a host and to the account, e.g. "Ada's iPhone". */
  deviceLabel: string
  uuid(): string
  /** Reads and uploads picked files for attachments. */
  attachmentIo?: AttachmentIo
  cloudOrigin?: string
  /** Puts this device's light or dark choice into effect for the whole app. */
  applyAppearance?(mode: AppearanceMode): void
  /** Network and app activity for settings sync; absent means always online and in front. */
  settingsSyncEnvironment?: SettingsSyncEnvironment
  /** This build's version, as About shows it. */
  appVersion?: string
}

/** Where the person was, restored on a returning launch once access is known. */
export interface LastRoute {
  hostId: string
  projectPath: string
  record?: ConversationTarget['record']
}

const LAST_ROUTE_KEY = 'solus.mobile.lastRoute'
const draftKey = (hostId: string, conversationKey: string) => `solus.mobile.draft.${hostId}/${conversationKey}`

const lastRouteSchema = z.object({
  hostId: z.string().min(1),
  projectPath: z.string(),
  record: z.object({
    sessionId: z.string().min(1),
    provider: z.enum(['claude-code', 'codex', 'opencode']),
    projectPath: z.string(),
    cwd: z.string().nullable(),
    model: z.string().nullable(),
    reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode']).nullable(),
    title: z.string().nullable(),
    customTitle: z.string().nullable(),
  }).optional(),
})

export class SolusApp {
  readonly registry: HostRegistry
  readonly connections: HostConnections
  readonly account: AccountSession
  /** Every session on every host, as T3 Code's home list reads it. */
  readonly threads: ThreadDirectory
  /** Each host's shelf (settled, snoozed), live status, and PR links, as T3 Code's list shows them. */
  readonly threadList: ThreadListState
  /** Whether this device shows agent work as a Live Activity (iOS). */
  readonly liveActivity: LiveActivityPreference
  readonly outbox: SendOutbox
  /** Notifications addressed to the person, from every host this device knows (plan 015). */
  readonly notifications: NativeNotificationHub
  /** Hardware keyboard commands the mounted screens handle. */
  readonly keyboard = new KeyboardCommands()
  /** The person's own settings: one local profile per account (plans/018). */
  readonly personal: PersonalSettingsStore
  /** Opt-in sync of the personal profile with the account. */
  readonly personalSync: PersonalSync
  /** Organization rules and host policy, read for everyone and edited by owners. */
  readonly organizationSettings: OrganizationSettingsStore
  /** The personal light or dark choice, as this device applies it. */
  readonly appearance: AppearancePreference
  /** Each host's own, host-owned settings. */
  readonly hostSettings: HostSettings
  /** Each host's link to the person's Solus Cloud account. */
  readonly hostCloudLink: HostCloudLink
  /** How each host is reached and who reaches it. */
  readonly hostAccess: HostAccess
  readonly pullRequests: PullRequestDirectory
  readonly files: ProjectFiles
  private readonly conversations = new Map<string, ConversationStore>()
  /** Each host's model list, read once per host per app run. */
  private readonly modelProfiles = new Map<string, Promise<void>>()
  private accountKey: string | null = null

  constructor(readonly platform: PlatformAdapters) {
    const { storage, secrets } = platform
    this.registry = new HostRegistry(storage, secrets)
    this.account = new AccountSession({
      client: new CloudAccountClient(platform.cloudOrigin ?? DEFAULT_CLOUD_ORIGIN, platform.fetch),
      registry: this.registry,
      secrets,
      storage,
      fetch: platform.fetch,
      now: () => Date.now(),
      sleep: (ms, signal) => new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms)
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
      }),
      openBrowser: platform.openBrowser,
      deviceLabel: platform.deviceLabel,
    })
    this.connections = new HostConnections({
      registry: this.registry,
      createTransport: platform.createTransport,
      acquireHostAccessToken: (host, options) => this.account.acquireHostAccessToken(host, options),
      organizationId: () => this.account.organizationId,
      fetch: platform.fetch,
    })
    this.threads = new ThreadDirectory(this.registry, (hostId) => this.connections.connection(hostId))
    this.threadList = new ThreadListState((hostId) => this.connections.connection(hostId), storage)
    this.liveActivity = new LiveActivityPreference(storage)
    this.personal = new PersonalSettingsStore(storage)
    this.appearance = new AppearancePreference(this.personal, (mode) => platform.applyAppearance?.(mode))
    this.personalSync = new PersonalSync(this.personal, {
      requests: this.account.settingsRequests(),
      storage,
      environment: platform.settingsSyncEnvironment ?? alwaysOnlineEnvironment,
      clock: timerClock,
    })
    this.organizationSettings = new OrganizationSettingsStore(new OrganizationSettingsClient(this.account.settingsRequests()))
    this.account.changes.subscribe(() => this.followAccount())
    this.hostSettings = new HostSettings((hostId) => this.connections.connection(hostId))
    this.hostAccess = new HostAccess((hostId) => this.connections.connection(hostId))
    this.hostCloudLink = new HostCloudLink((hostId) => this.connections.connection(hostId), () => this.account.issueEnrollmentTicket())
    this.pullRequests = new PullRequestDirectory((hostId) => this.connections.connection(hostId), () => this.account.organizationId)
    this.files = new ProjectFiles((hostId) => this.connections.connection(hostId), () => this.account.organizationId)
    this.outbox = new SendOutbox(() => storage)
    this.notifications = new NativeNotificationHub({
      registry: this.registry,
      connections: this.connections,
      identity: () => {
        const account = this.account.view
        return account.kind === 'signed-in' ? `account:${account.profile.id}` : 'device'
      },
    })
    this.registry.onHostRemoved((hostId) => this.cleanUpHost(hostId))
  }

  /** The load barrier: credentials and saved hosts are read before any route
   *  is restored or any host is dialed. */
  async load(): Promise<void> {
    this.appearance.applySaved()
    await Promise.all([this.registry.load(), this.account.load()])
    this.followAccount()
    if (this.account.isSignedIn) void this.account.refreshDirectory()
  }

  /** The route to restore, when its host is still known. A host that left
   *  (forgotten, or no longer listed) is not reopened. */
  lastRoute(): LastRoute | null {
    const raw = this.platform.storage.getItem(LAST_ROUTE_KEY)
    if (!raw) return null
    let decoded: ReturnType<typeof lastRouteSchema.safeParse>
    try {
      decoded = lastRouteSchema.safeParse(JSON.parse(raw))
    } catch {
      this.platform.storage.removeItem(LAST_ROUTE_KEY)
      return null
    }
    if (!decoded.success || !this.registry.host(decoded.data.hostId)) {
      this.platform.storage.removeItem(LAST_ROUTE_KEY)
      return null
    }
    return decoded.data
  }

  rememberRoute(route: LastRoute): void {
    this.platform.storage.setItem(LAST_ROUTE_KEY, JSON.stringify(route))
  }

  /** The host at an address, shown to the person before pairing. */
  preview(url: string): Promise<PreviewResult> {
    return previewHost(this.platform.fetch, url)
  }

  async pair(preview: Pick<HostPreview, 'url'> & Partial<HostPreview>, pairToken: string, serverLabel?: string): Promise<NativeHost> {
    const { server, sessionToken } = await pairServer({
      url: preview.url,
      pairToken,
      deviceLabel: this.platform.deviceLabel,
      serverLabel,
      reportedName: preview.name,
      fetchImpl: this.platform.fetch,
    })
    return this.registry.savePaired({
      id: server.id,
      label: server.label || urlHost(preview.url),
      hasUserLabel: server.hasUserLabel,
      url: server.url,
      os: server.os,
    }, sessionToken)
  }

  /** The open conversation for a saved session or a new one. One store per
   *  conversation, so a remount keeps the transcript, scroll, and watch. */
  conversation(hostId: string, target: { record?: Pick<SessionRecord, 'sessionId' | 'provider' | 'projectPath' | 'cwd' | 'model' | 'reasoningEffort' | 'title' | 'customTitle'>; newSession?: { sessionId: string; provider: AgentId; workingDirectory: string } }): ConversationStore | null {
    const key = conversationKey(hostId, target.record?.sessionId ?? target.newSession?.sessionId ?? '')
    const existing = this.conversations.get(key)
    if (existing) return existing
    const connection = this.connections.connection(hostId)
    if (!connection) return null
    const store = new ConversationStore({ hostId, ...target }, {
      connection,
      outbox: this.outbox,
      runSettings: () => this.settingsFor(hostId),
      executionPreferences: () => this.personal.executionPreferences(),
      saveModelOptions: (provider, model, options) => { this.personal.saveModelOptions(provider, model, options) },
      autoRenameSessions: () => this.personal.current().autoRenameSessions,
      organizationId: () => this.account.organizationId,
      uuid: this.platform.uuid,
      attachmentIo: this.platform.attachmentIo,
    })
    this.conversations.set(key, store)
    void store.controller.load()
    return store
  }

  /** The conversation already open under this id, for a sheet presented over its thread. */
  openConversation(hostId: string, conversationId: string): ConversationStore | null {
    return this.conversations.get(conversationKey(hostId, conversationId)) ?? null
  }

  closeConversation(store: ConversationStore): void {
    for (const [key, candidate] of this.conversations) {
      if (candidate !== store) continue
      this.conversations.delete(key)
      store.close()
    }
  }

  draft(hostId: string, conversationId: string): string {
    return this.platform.storage.getItem(draftKey(hostId, conversationId)) ?? ''
  }

  /** A draft lives until the host accepts the prompt; empty removes it. */
  saveDraft(hostId: string, conversationId: string, text: string): void {
    if (text) this.platform.storage.setItem(draftKey(hostId, conversationId), text)
    else this.platform.storage.removeItem(draftKey(hostId, conversationId))
  }

  newSessionId(): string {
    return this.platform.uuid()
  }

  /** The person's run settings, after the host's model list is in: it
   *  replaces the bundled one, as on desktop, because a host may know a model
   *  this build does not. A host too old to serve it keeps the bundle. */
  private async settingsFor(hostId: string): Promise<RunSettings> {
    let profiles = this.modelProfiles.get(hostId)
    if (!profiles) {
      const connection = this.connections.connection(hostId)
      profiles = connection ? readModelProfiles(connection.api) : Promise.resolve()
      this.modelProfiles.set(hostId, profiles)
    }
    await profiles
    return this.personal.runSettings()
  }

  /** Personal settings, sync, and organization views follow who is signed in. */
  private followAccount(): void {
    const account = this.account.syncAccount
    this.personalSync.followAccount(account)
    const accountKey = account ? settingsAccountKey(account) : null
    if (accountKey !== this.accountKey) this.organizationSettings.clear()
    this.accountKey = accountKey
  }

  /** Everything this device kept for a host leaves with it. */
  private cleanUpHost(hostId: string): void {
    for (const [key, store] of this.conversations) {
      if (store.controller.hostId !== hostId) continue
      this.conversations.delete(key)
      store.close()
    }
    this.threads.forgetHost(hostId)
    this.threadList.forgetHost(hostId)
    this.hostSettings.forgetHost(hostId)
    this.hostCloudLink.forgetHost(hostId)
    this.hostAccess.forgetHost(hostId)
    this.pullRequests.forgetHost(hostId)
    this.files.forgetHost(hostId)
    this.modelProfiles.delete(hostId)
    removeKeysWithPrefix(this.platform.storage, conversationOutboxPrefix(hostId))
    removeKeysWithPrefix(this.platform.storage, `solus.mobile.draft.${hostId}/`)
    // The host is already out of the registry, so this drops a route to it.
    this.lastRoute()
  }
}

async function readModelProfiles(api: HostApi): Promise<void> {
  const profiles = await api.modelProfilesStatus().then(({ profiles }) => profiles, () => null)
  if (profiles) replaceModelProfiles(profiles)
}

function conversationKey(hostId: string, sessionId: string): string {
  return `${hostId}\u0000${sessionId}`
}
