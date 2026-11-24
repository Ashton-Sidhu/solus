import { MobileSessionCache } from "../features/threads/session-cache"
import { z } from 'zod'
import { SendOutbox } from '@solus/client-core/send-outbox'
import { pairServer, urlHost } from '@solus/client-core/pairing'
import { askHostsToDiscover, mergeDiscovered } from '@solus/client-core/discovery-through-hosts'
import type { WsTransportOptions } from '@solus/client-core/ws-transport'
import { replaceModelProfiles, type DiscoveredServer, type SessionRecord } from '@solus/contracts/types'
import { toBase64Url } from '@solus/contracts/host-identity'
import type { HostApi } from '@solus/client-core/host-api'
import type { AddressReader } from '@solus/client-core/host-connection-check'
import type { DocumentSyncEnvironment } from '@solus/client-core/document-sync'
import type { BrowserAuthorizer, OAuthSessionDeps } from '@solus/client-core/oauth-session'
import { DEFAULT_CLOUD_ORIGIN } from '../features/account/account-client'
import { AccountSession } from '../features/account/account-session'
import { conversationOutboxPrefix, type ConversationTarget } from '../features/conversation/conversation-controller'
import type { AttachmentIo } from '../features/conversation/lib/attachments'
import { ConversationStore } from '../features/conversation/conversation-store'
import type { RunSettings } from '../features/conversation/lib/ipc-context'
import { HostConnections, type HostTransport } from '../features/hosts/host-connections'
import { KeyboardCommands } from '../features/keyboard/keyboard-commands'
import { HostRegistry } from '../features/hosts/host-registry'
import type { PairOutcome } from '@solus/client-core/host-catalog'
import { previewHost, type HostPreview, type PreviewResult } from '../features/hosts/lib/pair-input'
import { ThreadDirectory } from '../features/threads/thread-directory'
import { SessionRunHosts } from '../features/threads/session-run-hosts'
import { CloudSessions } from '../features/threads/cloud-sessions'
import { CloudHistory } from '../features/threads/cloud-history'
import { ThreadListState } from '../features/threads/thread-list-state'
import { NativeNotificationHub } from '../features/notifications/notification-hub'
import { DiffFilterPreference } from '../features/review/diff-filter-preference'
import { AppearancePreference, type AppearanceMode } from '../features/settings/appearance'
import { HostSettings } from '../features/settings/host-settings'
import { HostCloudLink } from '../features/settings/host-cloud-link'
import { ForwardedHosts } from '../features/hosts/forwarded-hosts'
import { Codebases } from '../features/codebases/codebases'
import { NativeDevices } from '../features/devices/native-devices'
import { NativeBrowser } from '../features/browser/native-browser'
import { HostAccess } from '../features/settings/host-access'
import { PairApprovals } from '../features/settings/pair-approvals'
import { LiveActivityPreference } from '../features/live-activity/live-activity-preference'
import { PersonalSettingsStore } from '../features/settings/personal-settings'
import { answerAgentPersonalRequests } from '@solus/client-core/agent-personal-requests'
import { HostPreferencesPublisher } from '@solus/client-core/host-preferences'
import { AgentProfileLocalStore } from '../features/settings/agent-profile-local'
import { AccountSync, alwaysOnlineEnvironment, timerClock, type ReachableHost } from '../features/account/account-sync'
import { PullRequestDirectory } from '../features/prs/pull-request-directory'
import { PullRequestDiffs } from '../features/prs/pull-request-diffs'
import { PullRequestGuides } from '../features/prs/pull-request-guides'
import { PullRequestReviewDrafts } from '../features/prs/pull-request-review-drafts'
import { PullRequestActions } from '../features/prs/pull-request-actions'
import { memoryPullRequestCacheDatabase, PullRequestCache, type PullRequestCacheDatabase } from '@solus/client-core/pull-request-cache'
import { rememberNewThreadTarget } from '../features/threads/new-thread-targets'
import { ProjectFiles } from '../features/files/project-files'
import { MobilePersonHistory } from '../features/history/person-history'
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
  readAddress?: AddressReader
  /** A GET that keeps the system's error text, for the add-host check; `fetch` when absent. */
  nativeGet?: typeof fetch
  createTransport(options: WsTransportOptions): HostTransport
  openBrowser(url: string): Promise<void>
  /** What this device calls itself to a host and to the account, e.g. "Ada's iPhone". */
  deviceLabel: string
  uuid(): string
  /** Reads and uploads picked files for attachments. */
  attachmentIo?: AttachmentIo
  cloudOrigin?: string
  /** The system browser step of the account sign-in (ADR 0001 §2.2 rule 1). */
  accountAuthorizer?: BrowserAuthorizer
  /** Random bytes and SHA-256 for the sign-in where the runtime has no Web Crypto (Hermes). */
  accountCrypto?: Pick<OAuthSessionDeps, 'randomBytes' | 'sha256'>
  /** Puts this device's light or dark choice into effect for the whole app. */
  applyAppearance?(mode: AppearanceMode): void
  /** Network and app activity for settings sync; absent means always online and in front. */
  settingsSyncEnvironment?: DocumentSyncEnvironment
  /** This build's version, as About shows it. */
  appVersion?: string
  /** Finds Solus hosts on this device's local network; absent where the build cannot scan. */
  scanLocalNetwork?(): Promise<DiscoveredServer[]>
  /** Where the pull request cache is kept; absent keeps it in memory for this app run. */
  pullRequestCache?: PullRequestCacheDatabase
}

/** Where the person was, restored on a returning launch once access is known. */
export interface LastRoute {
  hostId: string
  projectPath: string
  record?: ConversationTarget['record']
}

const LAST_ROUTE_KEY = 'solus.mobile.lastRoute'
/** How long a start waits for the host list and the directory before it chooses the first screen. */
const HOST_READ_WAIT_MS = 4_000
const draftKey = (hostId: string, conversationKey: string) => `solus.mobile.draft.${hostId}/${conversationKey}`

const lastRouteSchema = z.object({
  hostId: z.string().min(1),
  projectPath: z.string(),
  record: z.object({
    sessionId: z.string().min(1),
    provider: z.enum(['claude-code', 'codex', 'opencode', 'replay']),
    projectPath: z.string(),
    cwd: z.string().nullable(),
    model: z.string().nullable(),
    reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode']).nullable(),
    title: z.string().nullable(),
    customTitle: z.string().nullable(),
    // A session in a task folder names its project and its codebase only here (docs/plans/codebases.md §7).
    projectRoot: z.string().nullable().optional(),
    codebaseId: z.string().nullable().optional(),
  }).optional(),
})

export class SolusApp {
  readonly registry: HostRegistry
  readonly connections: HostConnections
  readonly account: AccountSession
  /** Every session on every host, as T3 Code's home list reads it. */
  readonly sessionCache: MobileSessionCache
  private sessionCacheScope: string | undefined
  readonly threads: ThreadDirectory
  /** What each host holds of each session, and where the next turn syncs from (docs/plans/portable-sessions.md §10). */
  readonly runHosts: SessionRunHosts
  /** What the cloud knows of this person's sessions, from the Solus API (docs/plans/portable-sessions-cloud.md §5.5). */
  readonly cloudSessions: CloudSessions
  /** A session's read-only copy from Solus Cloud, and its turn diffs, while no host that holds it is online (Phase 5B). */
  readonly cloudHistory: CloudHistory
  /** Each host's shelf (settled, snoozed), live status, and PR links, as T3 Code's list shows them. */
  readonly threadList: ThreadListState
  /** Whether this device shows agent work in a system activity card. */
  readonly liveActivity: LiveActivityPreference
  readonly outbox: SendOutbox
  /** Notifications addressed to the person, from every host this device knows (plan 015). */
  readonly notifications: NativeNotificationHub
  /** Hardware keyboard commands the mounted screens handle. */
  readonly keyboard = new KeyboardCommands()
  /** The person's own settings: one local profile per account (plans/018). */
  readonly personal: PersonalSettingsStore
  /** The person's agent profile on this device: one local copy per account (plans/020). */
  readonly agentProfile: AgentProfileLocalStore
  /** The account's sync of both, signed in, and the profile's copy on each host (plans/018 decision 9). */
  readonly accountSync: AccountSync
  /** The personal light or dark choice, as this device applies it. */
  readonly appearance: AppearancePreference
  /** Each host's own, host-owned settings. */
  readonly hostSettings: HostSettings
  /** Each host's link to the person's Solus Cloud account. */
  readonly hostCloudLink: HostCloudLink
  /** The SSH forwards each connected host holds (docs/plans/host-routes.md D7). */
  readonly forwardedHosts: ForwardedHosts
  /** How each host is reached and who reaches it. */
  readonly hostAccess: HostAccess
  /** The open approval requests of the hosts this phone may decide them on (docs/plans/add-machine-card.md). */
  readonly pairApprovals: PairApprovals
  /** The codebases of the hosts of this phone (docs/plans/codebases.md §10). */
  readonly codebases: Codebases
  readonly devices: NativeDevices
  /** Each host's browser pages and their streamed frames. */
  readonly browser: NativeBrowser
  /** The device copy of pull request data, for offline reading, and the review drafts. */
  readonly pullRequestCache: PullRequestCache
  readonly pullRequests: PullRequestDirectory
  readonly diffFilter: DiffFilterPreference
  readonly pullRequestDiffs: PullRequestDiffs
  readonly pullRequestGuides: PullRequestGuides
  readonly reviewDrafts: PullRequestReviewDrafts
  readonly pullRequestActions: PullRequestActions
  readonly files: ProjectFiles
  /** When the person last opened each work, app, file, and image, from their home (docs/plans/person-state.md). */
  readonly history: MobilePersonHistory
  private readonly readers = new Map<ConversationStore, number>()
  private readonly recent = new Map<ConversationStore, () => void>()
  private readonly conversations = new Map<string, ConversationStore>()
  /** Each host's model list, read once per host per app run. */
  private readonly modelProfiles = new Map<string, Promise<void>>()

  constructor(readonly platform: PlatformAdapters) {
    const { storage, secrets } = platform
    // The account reads the directory for the catalog; it is made next, and read only later.
    this.registry = new HostRegistry(storage, secrets, () => this.account)
    this.account = new AccountSession({
      cloudOrigin: platform.cloudOrigin ?? DEFAULT_CLOUD_ORIGIN,
      registry: this.registry,
      secrets,
      storage,
      fetch: platform.fetch,
      now: () => Date.now(),
      authorizer: platform.accountAuthorizer,
      crypto: platform.accountCrypto,
      scanLocalNetwork: platform.scanLocalNetwork,
    })
    this.connections = new HostConnections({
      registry: this.registry,
      createTransport: (options) => {
        const transport = platform.createTransport(options)
        // An agent on this host reads and changes the person's settings and agent profile through this phone (docs/settings.md).
        answerAgentPersonalRequests(transport, {
          settings: () => this.personal.current(),
          applySettings: (patch) => this.personal.set(patch) === 'saved',
          profile: () => this.agentProfile.entries(),
          applyProfile: (change) => {
            const entries = Object.values(change.set)
            if (entries.length > 0 && this.agentProfile.setEntry(entries) !== 'saved') return false
            this.agentProfile.removeKeys(change.reset)
            return true
          },
        })
        return transport
      },
      hostAccessToken: (host, options) => this.account.hostAccessToken(host, options),
      isSignedOut: () => this.account.isSignedOut(),
      dialOrganizationId: (host) => this.account.dialOrganizationId(host),
      organizationId: () => this.account.organizationId,
      solusApiRoutes: (organizationId) => this.account.solusApiRoutes(organizationId),
      solusApiAccessToken: (options) => this.account.solusApiAccessToken(options),
      fetch: platform.fetch,
      clientVersion: platform.appVersion ?? 'unknown',
      readAddress: platform.readAddress,
      healthNonce: platform.accountCrypto?.randomBytes ? () => toBase64Url(platform.accountCrypto!.randomBytes!(16)) : undefined,
    })
    this.cloudSessions = new CloudSessions({
      // The cloud names a host by its account host id (`uplink.hostId`), not by the id this phone keeps it under.
      savedHostFor: (accountHostId) => this.registry.hosts().find((host) => host.uplink?.hostId === accountHostId)?.id ?? null,
      isReady: (hostId) => this.connections.state(hostId)?.readiness === 'ready',
      hostIds: () => this.registry.hosts().map((host) => host.id),
    })
    this.cloudHistory = new CloudHistory(this.cloudSessions)
    // A host that connects or drops changes which cloud rows show and who runs a turn.
    this.connections.changes.subscribe(() => { if (this.cloudSessions.recordCount > 0) this.cloudSessions.changes.notify() })
    this.runHosts = new SessionRunHosts({
      readyConnection: (hostId) => this.connections.readyConnections().find((connection) => connection.hostId === hostId) ?? null,
      cloudHeadFor: this.cloudSessions.headFor,
    })
    this.pullRequestCache = new PullRequestCache(platform.pullRequestCache ?? memoryPullRequestCacheDatabase())
    this.sessionCache = new MobileSessionCache(this.pullRequestCache, () => JSON.stringify([this.account.syncAccount, this.account.organizationId]))
    this.threads = new ThreadDirectory(this.registry, (hostId) => this.connections.connection(hostId), this.runHosts, this.cloudSessions, (hostId) => this.threadList.loadPins(hostId), this.sessionCache, (hostId, path) => this.codebases.isContainerRoot(hostId, path))
    this.threadList = new ThreadListState((hostId) => this.connections.connection(hostId), storage)
    this.liveActivity = new LiveActivityPreference(storage)
    this.diffFilter = new DiffFilterPreference(storage)
    this.personal = new PersonalSettingsStore(storage)
    this.appearance = new AppearancePreference(this.personal, (mode) => platform.applyAppearance?.(mode))
    this.agentProfile = new AgentProfileLocalStore(storage)
    this.accountSync = new AccountSync(this.personal, this.agentProfile, {
      settingsRequests: this.account.settingsRequests(),
      profileRequests: this.account.agentProfileRequests(),
      storage,
      environment: platform.settingsSyncEnvironment ?? alwaysOnlineEnvironment,
      clock: timerClock,
    }, () => this.reachableHosts())
    this.account.changes.subscribe(() => this.followAccount())
    // Each connected host keeps a copy of the person's preferences, which their work there reads (docs/plans/host-preferences.md).
    const hostPreferences = new HostPreferencesPublisher({
      preferences: () => this.personal.executionPreferences(),
      readyHosts: () => this.connections.readyConnections().map((connection) => ({ hostId: connection.hostId, api: connection.api })),
    })
    this.connections.changes.subscribe(() => hostPreferences.publish())
    this.personal.changes.subscribe(() => hostPreferences.publish())
    this.hostSettings = new HostSettings((hostId) => this.connections.connection(hostId))
    this.devices = new NativeDevices((hostId) => this.connections.connection(hostId))
    this.browser = new NativeBrowser((hostId) => this.connections.connection(hostId), platform.attachmentIo?.uploadFile ?? null)
    this.hostAccess = new HostAccess((hostId) => this.connections.connection(hostId))
    this.pairApprovals = new PairApprovals({
      readyConnections: () => this.connections.readyConnections(),
      mayReach: (hostId) => this.connections.may(hostId, 'host.local.reach'),
      onChange: (listener) => this.connections.changes.subscribe(listener),
    })
    this.hostCloudLink = new HostCloudLink((hostId) => this.connections.connection(hostId), () => this.account.issueEnrollmentTicket(), () => this.account.isSignedIn)
    this.forwardedHosts = new ForwardedHosts((hostId) => this.connections.connection(hostId), () => this.account.issueEnrollmentTicket(), () => void this.account.refreshDirectory())
    this.codebases = new Codebases({
      scope: () => this.sessionCache.scope(),
      machines: () => this.registry.hosts().map((host) => {
        const state = this.connections.state(host.id)
        // A host that is not ready is not dialed here, and a person who may not use the host does not read its codebases.
        const connection = state?.readiness === 'ready' && this.connections.may(host.id, 'host.use') ? this.connections.connection(host.id) : null
        return {
          hostId: host.id,
          // The host's own answer first; the saved host entry until it answers.
          installationId: connection?.facts.value('serverInfo')?.installationId ?? host.installationId,
          label: host.label,
          connection,
          generation: state?.sessionGeneration ?? 0,
        }
      }),
      onChange: (listener) => {
        const stops = [this.registry.changes.subscribe(listener), this.connections.changes.subscribe(listener), this.account.changes.subscribe(listener)]
        return () => { for (const stop of stops) stop() }
      },
      uuid: platform.uuid,
    })
    // A container root of a codebase is not a project: the project list follows the codebases.
    this.codebases.changes.subscribe(() => this.threads.followContainerRoots())
    const connectionFor = (hostId: string) => this.connections.connection(hostId)
    const organizationId = () => this.account.organizationId
    this.pullRequests = new PullRequestDirectory(connectionFor, organizationId, this.pullRequestCache)
    this.pullRequestDiffs = new PullRequestDiffs(connectionFor, this.pullRequests, this.pullRequestCache)
    this.pullRequestGuides = new PullRequestGuides(connectionFor, organizationId, this.pullRequestCache)
    this.reviewDrafts = new PullRequestReviewDrafts(this.pullRequestCache, platform.uuid)
    this.pullRequestActions = new PullRequestActions({
      connectionFor,
      organizationId,
      directory: this.pullRequests,
      drafts: this.reviewDrafts,
      startSession: (hostId, workingDirectory, prompt) => this.startSession(hostId, workingDirectory, prompt),
    })
    this.files = new ProjectFiles((hostId) => this.connections.connection(hostId), () => this.account.organizationId)
    this.history = new MobilePersonHistory({
      account: () => {
        const organizationId = this.account.isSignedIn ? this.account.organizationId : null
        return { signedIn: this.account.isSignedIn, solusApiId: organizationId ? this.connections.solusApi(organizationId)?.hostId ?? null : null }
      },
      // A phone has no default host of its own: the first host it keeps is the one its history stays on, signed out.
      defaultHostId: () => this.registry.hosts()[0]?.id ?? null,
      // The history never dials: a host is read once it is connected, and the Solus API once `followCloudSessions` dials it.
      connection: (serverId) => this.connections.readyConnections().find((connection) => connection.hostId === serverId) ?? null,
      onChange: (listener) => {
        const stops = [this.registry.changes.subscribe(listener), this.connections.changes.subscribe(listener), this.account.changes.subscribe(listener)]
        return () => { for (const stop of stops) stop() }
      },
    })
    this.outbox = new SendOutbox(() => storage)
    this.notifications = new NativeNotificationHub({
      registry: this.registry,
      connections: this.connections,
      identity: () => {
        const account = this.account.view
        return account.kind === 'signed-in' ? `account:${account.identity.sub}` : 'device'
      },
      // A new notice can be a session shared with the reader: the host's list reads
      // again, and its new share brings the row and the toast (docs/plans/shared-with-you.md §6).
      onUnreadRose: (hostId) => { void this.threads.load(hostId, 0, 'sessions') },
    })
    this.registry.onHostRemoved((hostId) => this.cleanUpHost(hostId))
  }

  /**
   * The load barrier: credentials are read before any route is restored or any
   * host is dialed. The phone keeps no copy of its hosts (plans/033 §3 Q2), so the
   * start also waits a short time for the host list and the directory: the first
   * screen depends on whether there are hosts.
   */
  async load(onLocalReady?: () => void): Promise<void> {
    this.appearance.applySaved()
    await Promise.all([this.registry.load(), this.account.load()])
    this.followAccount()
    onLocalReady?.()
    const reads: Promise<void>[] = [this.account.hostListRead]
    if (this.account.isSignedIn) {
      // The kept identity can be old: the name or picture may have changed on the website.
      void this.account.refreshIdentity()
      reads.push(this.account.refreshDirectory())
    }
    await settledWithin(Promise.all(reads), HOST_READ_WAIT_MS)
  }

  /** The route to restore, when its host is still known. A host that left
   *  (forgotten, or no longer listed) is not reopened. */
  lastRoute(): LastRoute | null {
    const route = this.storedRoute()
    if (!route || this.registry.host(route.hostId)) return route
    // Before the list answers, its hosts are not known yet: the route stays for the next start.
    if (this.registry.listState() === 'ready') this.platform.storage.removeItem(LAST_ROUTE_KEY)
    return null
  }

  private storedRoute(): LastRoute | null {
    const raw = this.platform.storage.getItem(LAST_ROUTE_KEY)
    if (!raw) return null
    let decoded: ReturnType<typeof lastRouteSchema.safeParse> | null
    try {
      decoded = lastRouteSchema.safeParse(JSON.parse(raw))
    } catch {
      decoded = null
    }
    if (decoded?.success) return decoded.data
    this.platform.storage.removeItem(LAST_ROUTE_KEY)
    return null
  }

  rememberRoute(route: LastRoute): void {
    this.platform.storage.setItem(LAST_ROUTE_KEY, JSON.stringify(route))
  }

  /** Whether this build can look for hosts on the local network. */
  get canScanNearby(): boolean {
    return !!this.platform.scanLocalNetwork
  }

  /**
   * Hosts on the local network or the tailnet that this device has not paired yet.
   * The phone cannot read the tailnet, so each connected host is asked for the
   * tailnet hosts it sees (docs/plans/tailscale-support.md D3). A managed host
   * advertises no tailnet routes, so it is not asked.
   */
  async scanNearby(): Promise<DiscoveredServer[]> {
    const hosts = this.connections.readyConnections().filter((connection) => {
      const uplink = this.registry.host(connection.hostId)?.uplink
      return uplink?.kind !== 'managed' && uplink?.category !== 'managed'
    })
    const [own, fromHosts] = await Promise.all([
      this.platform.scanLocalNetwork?.() ?? [],
      askHostsToDiscover(hosts.map((connection) => () => connection.api.discoverServers())),
    ])
    const found = mergeDiscovered(own, fromHosts)
    // A directory host found here is dialed here (ADR 0001 §2.2 rule 9).
    this.registry.applyNearby(found)
    return found.filter((server) => !this.registry.host(server.installationId)?.sessionToken)
  }

  /** The host at an address, shown to the person before pairing. */
  preview(url: string): Promise<PreviewResult> {
    return previewHost(this.platform.nativeGet ?? this.platform.fetch, url)
  }

  /** Pairs a host: its credential stays on this phone, its listing goes to the person's list (`listError` when it did not). */
  async pair(preview: Pick<HostPreview, 'url'> & Partial<HostPreview>, pairToken: string | undefined, serverLabel?: string): Promise<PairOutcome> {
    const { server, sessionToken } = await pairServer({
      url: preview.url,
      pairToken,
      deviceLabel: this.platform.deviceLabel,
      serverLabel,
      reportedName: preview.name,
      fetchImpl: this.platform.fetch,
      onTailnet: preview.onTailnet,
    })
    return this.registry.savePaired({
      id: server.id,
      label: server.label || urlHost(preview.url),
      hasUserLabel: server.hasUserLabel,
      url: server.routes[0]?.url ?? preview.url,
      os: server.os,
      identityKey: server.identityKey,
      onTailnet: preview.onTailnet,
    }, sessionToken)
  }

  /** The open conversation for a saved session or a new one. One store per
   *  conversation, so a remount keeps the transcript, scroll, and watch. */
  conversation(hostId: string, target: Omit<ConversationTarget, 'hostId' | 'record'> & { record?: Pick<SessionRecord, 'sessionId' | 'provider' | 'projectPath' | 'cwd' | 'model' | 'reasoningEffort' | 'title' | 'customTitle'> }): ConversationStore | null {
    const key = conversationKey(hostId, target.record?.sessionId ?? target.newSession?.sessionId ?? '')
    const existing = this.conversations.get(key)
    if (existing) return existing
    const connection = this.connections.connection(hostId)
    if (!connection) return null
    const store = new ConversationStore({ hostId, ...target }, {
      sessionCache: this.sessionCache.forHost(hostId),
      connection,
      taskApi: (taskHostId) => {
        const taskConnection = this.connections.connection(taskHostId)
        if (!taskConnection) throw new Error('The task host is disconnected.')
        return taskConnection.api
      },
      outbox: this.outbox,
      runSettings: () => this.settingsFor(hostId),
      saveModelOptions: (provider, model, options) => { this.personal.saveModelOptions(provider, model, options) },
      autoRenameSessions: () => this.personal.current().autoRenameSessions,
      organizationId: () => this.account.organizationId,
      uuid: this.platform.uuid,
      attachmentIo: this.platform.attachmentIo,
      runHosts: this.runHosts,
      cloudHistory: this.cloudHistory,
    })
    this.conversations.set(key, store)
    void store.controller.load()
    return store
  }

  /**
   * The person chose another host to run the next turn of a started session
   * (docs/plans/portable-sessions.md §10). The conversation opens on that host
   * at once, with the transcript it shows and its draft, and the one on the
   * host it leaves closes. That host syncs in the background when it is
   * behind; nothing waits for it. Null when the host cannot be reached.
   */
  moveConversation(store: ConversationStore, hostId: string): ConversationStore | null {
    const { controller } = store
    const record = controller.target.record
    if (!record || hostId === controller.hostId || !this.connections.connection(hostId)) return null
    // A conversation left open there earlier shows an old transcript.
    const earlier = this.conversations.get(conversationKey(hostId, record.sessionId))
    if (earlier) this.closeConversation(earlier)
    const moved = this.conversation(hostId, { record, movedFrom: controller.hostId, carriedTranscript: controller.model })
    if (!moved) return null
    this.saveDraft(hostId, record.sessionId, this.draft(controller.hostId, record.sessionId))
    this.saveDraft(controller.hostId, record.sessionId, '')
    this.closeConversation(store)
    return moved
  }

  /** The conversation already open under this id, for a sheet presented over its thread. */
  openConversation(hostId: string, conversationId: string): ConversationStore | null {
    return this.conversations.get(conversationKey(hostId, conversationId)) ?? null
  }

  /** Keep the last three visited threads on their existing WebSocket watches.
   * The transport replays missed events. A reset discards a hidden watch. */
  observeConversation(store: ConversationStore): () => void {
    const { controller } = store
    const wasRecent = this.recent.get(store)
    if (wasRecent) {
      wasRecent()
      this.recent.delete(store)
      controller.retained = false
      void this.connections.connection(controller.hostId)?.api
        .setSessionReadState(controller.run.sessionId, Date.now()).catch(() => {})
    }
    this.readers.set(store, (this.readers.get(store) ?? 0) + 1)
    return () => {
      const readers = this.readers.get(store)
      if (!readers) return
      if (readers > 1) { this.readers.set(store, readers - 1); return }
      this.readers.delete(store)
      const connection = this.connections.connection(controller.hostId)
      if (!controller.hasStarted || controller.phase.kind !== 'ready' || !connection) {
        this.closeConversation(store)
        return
      }
      controller.retained = true
      const close = () => this.closeConversation(store)
      const stops = [
        connection.onReset(close),
        connection.events.subscribe('share.changed', ({ resource }) => {
          if (resource.kind === 'session' && resource.id === controller.run.sessionId) {
            void this.sessionCache.forHost(controller.hostId).saveHistory(resource.id, null)
            close()
          }
        }),
        connection.events.subscribe('session.transcriptChanged', ({ sessionId }) => {
          if (sessionId === controller.run.sessionId) close()
        }),
      ]
      this.recent.set(store, () => stops.forEach(stop => stop()))
      if (this.recent.size > 3) this.closeConversation(this.recent.keys().next().value!)
    }
  }

  releaseRecentConversations(): void {
    for (const store of this.recent.keys()) this.closeConversation(store)
  }

  closeConversation(store: ConversationStore): void {
    this.readers.delete(store)
    this.recent.get(store)?.()
    this.recent.delete(store)
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

  /** Ends this app object: its watches, sync, and host sockets. Saved state stays. */
  dispose(): void {
    for (const store of this.conversations.values()) this.closeConversation(store)
    this.conversations.clear()
    this.accountSync.dispose()
    this.history.dispose()
    this.connections.disposeAll()
  }

  newSessionId(): string {
    return this.platform.uuid()
  }

  /** A new session that sends its first prompt now, as the new-task sheet
   *  starts one. The thread route opens it by its id. */
  private startSession(hostId: string, workingDirectory: string, prompt: string): string {
    const sessionId = this.newSessionId()
    const store = this.conversation(hostId, { newSession: { sessionId, provider: 'claude-code', workingDirectory } })
    if (!store) throw new Error('This host cannot be reached now.')
    rememberNewThreadTarget(hostId, { sessionId, provider: store.controller.run.provider, workingDirectory: store.controller.run.workingDirectory })
    // A send that fails shows in the session's own transcript.
    void store.controller.send(prompt).catch(() => undefined)
    return sessionId
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

  /** Personal settings, sync, and the cloud's sessions follow who is signed in. */
  private followAccount(): void {
    const scope = this.sessionCache.scope()
    if (this.sessionCacheScope !== undefined && this.sessionCacheScope !== scope) {
      for (const store of this.conversations.values()) this.closeConversation(store)
      this.conversations.clear()
      for (const host of this.registry.hosts()) this.threads.forgetHost(host.id)
    }
    this.sessionCacheScope = scope
    this.threads.selectOrganization(this.account.organizationId)
    const account = this.account.syncAccount
    this.accountSync.followAccount(account)
    this.followCloudSessions()
    this.history.chooseHome()
  }

  /**
   * The cloud's sessions come from the Solus API of the organization this
   * device works in: `listMySessions` answers the person's own sessions on
   * any of them. Signed out, or with no organization, there is none, and the
   * cloud rows go. A sign-out also ends that connection: it belongs to the account.
   */
  private followCloudSessions(): void {
    const organizationId = this.account.isSignedIn ? this.account.organizationId : null
    const previousId = this.cloudSessions.connectionId
    this.cloudSessions.follow(organizationId ? this.connections.solusApi(organizationId) : null)
    if (previousId && !this.account.isSignedIn) this.connections.dispose(previousId)
  }

  /** The hosts this device is connected to now, each with its API: the ones a profile nudge can reach. */
  private reachableHosts(): ReachableHost[] {
    const hosts: ReachableHost[] = []
    for (const host of this.registry.hosts()) {
      if (this.connections.state(host.id)?.readiness !== 'ready') continue
      const connection = this.connections.connection(host.id)
      if (connection) hosts.push({ hostId: host.id, api: connection.api })
    }
    return hosts
  }

  /** Everything this device kept for a host leaves with it. */
  private cleanUpHost(hostId: string): void {
    for (const store of this.conversations.values()) {
      if (store.controller.hostId !== hostId) continue
      this.closeConversation(store)
    }
    this.threads.forgetHost(hostId)
    this.runHosts.forgetHost(hostId)
    this.threadList.forgetHost(hostId)
    this.hostSettings.forgetHost(hostId)
    this.hostCloudLink.forgetHost(hostId)
    this.forwardedHosts.forgetHost(hostId)
    this.codebases.forgetHost(hostId)
    this.hostAccess.forgetHost(hostId)
    this.devices.forgetHost(hostId)
    this.browser.forgetHost(hostId)
    this.accountSync.forgetHost(hostId)
    this.pullRequests.forgetHost(hostId)
    this.pullRequestDiffs.forgetHost(hostId)
    this.pullRequestGuides.forgetHost(hostId)
    this.reviewDrafts.forgetHost(hostId)
    void this.pullRequestCache.forgetHost(hostId)
    this.files.forgetHost(hostId)
    this.modelProfiles.delete(hostId)
    removeKeysWithPrefix(this.platform.storage, conversationOutboxPrefix(hostId))
    removeKeysWithPrefix(this.platform.storage, `solus.mobile.draft.${hostId}/`)
    if (this.storedRoute()?.hostId === hostId) this.platform.storage.removeItem(LAST_ROUTE_KEY)
  }
}

async function readModelProfiles(api: HostApi): Promise<void> {
  const profiles = await api.modelProfilesStatus().then(({ profiles }) => profiles, () => null)
  if (profiles) replaceModelProfiles(profiles)
}

/** Resolves when `work` settles or after `ms`, whichever is first. */
function settledWithin(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    work.then(done, done)
  })
}

function conversationKey(hostId: string, sessionId: string): string {
  return `${hostId}\u0000${sessionId}`
}
