import { serverConnections } from '@client-core/server-connections'
import type { SolusAPI } from '../../../preload'
import type {
  CloneAuth,
  CloneProtocol,
  DeviceCodePrompt,
  GitCommitIdentity,
  HostReadiness,
  IpcContext,
  RecentProject,
  ServerCapabilities,
  SetupAgent,
  SetupGithubRepo,
  SetupLogEvent,
  SetupSshAccessResult,
  SetupStatusEvent,
} from '../../../shared/types'
import {
  classifyCloneInput,
  cloneUrlForIntent,
  cloneUrlForProtocol,
  matchesRepoQuery,
  type CloneIntent,
} from './lib/clone-url'
import { classifyCloneFailure, pushCapabilityNote, type CloneFailure } from './lib/clone-outcome'
import {
  joinHostPath,
  type HostOption,
  type OpenProjectStep,
  type ProjectSource,
} from './lib/open-project-flow'

/**
 * The Open project flow: one home screen — a recent project, a folder, GitHub,
 * a URL — and the machine it all lands on, bound on open and changed from the
 * header chip rather than from a step of its own.
 *
 * Every call resolves the API for `serverId` — `window.solus` never appears
 * here, because the host being opened on is often not the active one. The store
 * also stays free of toasts and sibling stores so it can be unit-tested for
 * exactly that invariant; callers hand it the host list at the moment they open
 * it, ordered active-machine-first, and the first entry becomes the default.
 */

const LOG_LIMIT = 500
/** How many recent projects home offers before the three actions take over. */
const HOME_RECENTS_LIMIT = 3
const SEEN_HOSTS_KEY = 'solus.newProject.seenHosts'

export type CloneStatus = 'idle' | 'running' | 'done' | 'failed'

export interface OpenProjectOptions {
  /** The tab a successful open retargets at the project. */
  tabId?: string
  /** The machine to bind, instead of the first one in the host list. */
  host?: HostOption
  /** Prefills the clone box — e.g. the repo the current tab is in. */
  seed?: string
  /** Skips home for entry points that already know what is being opened. */
  source?: ProjectSource
}

type ResolveApi = (serverId: string) => SolusAPI

export class OpenProjectStore {
  isOpen = $state(false)
  step = $state<OpenProjectStep>('home')
  source = $state<ProjectSource | null>(null)

  serverId = $state<string | null>(null)
  hostLabel = $state('')
  hostIsLocal = $state(true)
  tabId = $state<string | null>(null)
  /** False the first time a host is used, which is when the credentials note matters. */
  hostSeenBefore = $state(true)

  readiness = $state<HostReadiness | null>(null)
  /** The agent half of readiness: whether this host can actually run a session. */
  capabilities = $state<ServerCapabilities | null>(null)
  readinessLoading = $state(false)
  readinessError = $state<string | null>(null)

  /** The clone URL for `clone`, or the filter for `github`. */
  query = $state('')
  protocol = $state<CloneProtocol>('https')

  /** Home's one box: it filters recents, and recognises a pasted clone URL. */
  homeQuery = $state('')
  /** The bound host's projects, as home's first offer. */
  recents = $state<RecentProject[]>([])
  recentsLoading = $state(false)

  repos = $state<SetupGithubRepo[]>([])
  reposLoading = $state(false)
  reposConnected = $state<boolean | null>(null)
  reposError = $state<string | null>(null)
  selectedRepoFullName = $state<string | null>(null)

  logLines = $state<string[]>([])
  cloneStatus = $state<CloneStatus>('idle')
  cloneError = $state<string | null>(null)
  clonedPath = $state<string | null>(null)
  /** The directory a failed clone left behind, so retry can offer to remove it. */
  partialPath = $state<string | null>(null)
  /** How the last clone authenticated — the only thing that says whether this host can also push. */
  cloneAuth = $state<CloneAuth | null>(null)
  adoptingProject = $state(false)

  installingGit = $state(false)
  savingIdentity = $state(false)
  connectingGithub = $state(false)
  authorizingGhCli = $state(false)
  installingCredentialHelper = $state(false)
  installingAgent = $state(false)
  checkingSshAccess = $state(false)

  deviceCode = $state<DeviceCodePrompt | null>(null)
  sshAccess = $state<SetupSshAccessResult | null>(null)
  /** The last repair action's failure, shown beside the rail rather than as a toast. */
  actionError = $state<string | null>(null)

  private readonly resolveApi: ResolveApi
  private unsubscribes: Array<() => void> = []
  /** Set by whichever action started a clone, so a retry lands in the same place. */
  private lastCloneDestination: string | undefined = undefined

  constructor(resolveApi: ResolveApi = (serverId) => serverConnections.apiFor(serverId)) {
    this.resolveApi = resolveApi
  }

  // ── What the current step commits to ────────────────────────────────────────

  get platform(): string | null {
    return this.readiness?.platform ?? this.capabilities?.platform ?? null
  }

  /** Where the primary action puts a project on this host. */
  get projectsRoot(): string {
    return this.readiness?.projectsRoot ?? this.capabilities?.projectsBaseDirectory ?? '~'
  }

  /**
   * Falls back to the first row rather than tracking it: filtering the list can
   * drop whatever was highlighted, and a stale id would silently disable the CTA.
   */
  get selectedRepo(): SetupGithubRepo | null {
    const visible = this.filteredRepos
    return visible.find((repo) => repo.fullName === this.selectedRepoFullName) ?? visible[0] ?? null
  }

  /** The clone URL this step would run, or null when there is nothing to clone. */
  get cloneUrl(): string | null {
    if (this.source === 'github') {
      const repo = this.selectedRepo
      return repo ? cloneUrlForProtocol(repo.cloneUrl, this.protocol) : null
    }
    if (this.source !== 'clone') return null
    return cloneUrlForIntent(classifyCloneInput(this.query), this.protocol)
  }

  /** The folder name a clone lands in. */
  get projectName(): string | null {
    if (this.source === 'github') return this.selectedRepo?.name ?? null
    const intent = classifyCloneInput(this.query)
    return intent.kind === 'owner-repo' || intent.kind === 'clone-url' ? intent.repoName : null
  }

  /**
   * Where the primary action lands. Only a preview: the host resolves the final
   * path itself, and de-duplicates a name that is already taken there.
   */
  get destinationPreview(): string | null {
    const name = this.projectName
    return name ? joinHostPath(this.projectsRoot, name, this.platform) : null
  }

  /** The repo list, narrowed by the filter box. */
  get filteredRepos(): SetupGithubRepo[] {
    return this.repos.filter((repo) => matchesRepoQuery(repo.fullName, this.query))
  }

  /**
   * Home's recents, narrowed by what was typed into the search pill and capped
   * so the three actions below them stay on screen without scrolling. The list
   * is newest-first, so the cap keeps the ones worth offering.
   */
  get filteredRecents(): RecentProject[] {
    const needle = this.homeQuery.trim().toLowerCase()
    const matches = needle
      ? this.recents.filter(
          (project) =>
            project.folderName.toLowerCase().includes(needle) || project.path.toLowerCase().includes(needle),
        )
      : this.recents
    return matches.slice(0, HOME_RECENTS_LIMIT)
  }

  /**
   * What home's box was asked to do. A pasted clone URL is offered as a clone
   * rather than filtered against recents it can never match.
   */
  get homeIntent(): CloneIntent {
    return classifyCloneInput(this.homeQuery)
  }

  get canSubmit(): boolean {
    if (this.cloneStatus === 'running') return false
    return !!this.cloneUrl
  }

  /** SSH only works off a key that lives on the host — nothing carries over from the client. */
  get sshKeyMissing(): boolean {
    return this.protocol === 'ssh' && (this.readiness?.ssh.publicKeys.length ?? 0) === 0
  }

  /** Cloning a private repo over HTTPS needs a token on the host doing the clone. */
  get needsGithubOnHost(): boolean {
    return this.source === 'github' && this.reposConnected === false
  }

  /** The last clone failure as something to act on, rather than as git's output. */
  get cloneFailure(): CloneFailure | null {
    return this.cloneError ? classifyCloneFailure(this.cloneError, this.hostLabel) : null
  }

  /** Set when the clone worked but the host still can't push what it produces. */
  get pushCapabilityNote(): string | null {
    return this.cloneAuth ? pushCapabilityNote(this.cloneAuth, this.hostLabel) : null
  }

  // ── Navigation ──────────────────────────────────────────────────────────────

  /**
   * A machine is bound before anything is asked, so nothing in the flow ever
   * waits on the question — `hosts` is ordered active-machine-first by the
   * caller, and the header chip changes the answer at any point.
   */
  open(hosts: HostOption[], options: OpenProjectOptions = {}): void {
    this.reset()
    this.isOpen = true
    this.tabId = options.tabId ?? null
    this.query = options.seed ?? ''
    this.step = 'home'
    this.source = null
    this.serverId = null
    this.hostLabel = ''

    const host = options.host ?? hosts[0]
    if (host) {
      this.bindHost(host)
      void this.refreshReadiness()
      void this.loadRecents()
    }

    if (options.source === 'local') this.browseFolder()
    else if (options.source === 'github') this.chooseGithub()
    else if (options.source === 'clone') this.chooseCloneUrl(options.seed)
  }

  /** Rebinds every later call to another machine, without leaving the screen. */
  selectHost(host: HostOption): void {
    this.bindHost(host)
    void this.refreshReadiness()
    void this.loadRecents()
    if (this.source === 'github') void this.loadRepos()
  }

  browseFolder(): void {
    this.source = 'local'
    this.query = ''
    this.step = 'browse'
  }

  chooseGithub(): void {
    this.source = 'github'
    this.selectedRepoFullName = null
    this.query = ''
    this.step = 'destination'
    void this.loadRepos()
  }

  chooseCloneUrl(seed?: string): void {
    this.source = 'clone'
    this.selectedRepoFullName = null
    this.query = seed ?? ''
    this.step = 'destination'
  }

  beginBrowse(): void {
    this.step = 'browse'
  }

  /**
   * Home is the only place to step back to — except from the folder browser a
   * clone opened to choose its destination, which would otherwise throw away
   * the URL that sent it there.
   */
  back(): void {
    if (this.step === 'browse' && this.source !== 'local') {
      this.step = 'destination'
      return
    }
    if (this.step === 'destination' || this.step === 'cloning') {
      this.cloneError = null
      this.logLines = []
      this.cloneStatus = 'idle'
    }
    this.step = 'home'
  }

  close(): void {
    this.isOpen = false
    for (const unsubscribe of this.unsubscribes) unsubscribe()
    this.unsubscribes = []
    void this.cancelGithubConnect()
  }

  // ── Host data ───────────────────────────────────────────────────────────────

  async refreshReadiness(): Promise<void> {
    const api = this.api()
    if (!api) return
    const issuedFor = this.serverId
    this.readinessLoading = true
    this.readinessError = null
    try {
      const [readiness, capabilities] = await Promise.all([
        api.setupHostReadiness(),
        api.getServerCapabilities().catch(() => null),
      ])
      if (this.serverId !== issuedFor) return
      this.readiness = readiness
      this.capabilities = capabilities
      if (this.reposConnected === null && readiness.github.solusToken) {
        this.reposConnected = true
      }
    } catch (err) {
      if (this.serverId === issuedFor) this.readinessError = messageFor(err)
    } finally {
      if (this.serverId === issuedFor) this.readinessLoading = false
    }
  }

  /** Home's recents, per host — nothing about them carries across machines. */
  async loadRecents(): Promise<void> {
    const api = this.api()
    if (!api) return
    const issuedFor = this.serverId
    this.recentsLoading = true
    try {
      const recents = await api.listRecentProjects()
      if (this.serverId === issuedFor) this.recents = recents
    } catch {
      // Home still offers the three actions; an unreachable host just has
      // nothing to list, which the empty state already says.
      if (this.serverId === issuedFor) this.recents = []
    } finally {
      if (this.serverId === issuedFor) this.recentsLoading = false
    }
  }

  async loadRepos(): Promise<void> {
    const api = this.api()
    if (!api || this.reposLoading) return
    const issuedFor = this.serverId
    this.reposLoading = true
    this.reposError = null
    try {
      const result = await api.setupListGithubRepos()
      if (this.serverId !== issuedFor) return
      this.reposConnected = result.connected
      this.repos = result.connected ? result.repos : []
    } catch (err) {
      // A disconnected response is the only evidence that credentials are
      // missing. Network/server failures must not overwrite a known sign-in
      // with the much more alarming "Connect GitHub" state.
      if (this.serverId !== issuedFor) return
      this.reposError = messageFor(err)
      this.repos = []
    } finally {
      if (this.serverId === issuedFor) this.reposLoading = false
    }
  }

  // ── Committing ──────────────────────────────────────────────────────────────

  /**
   * The primary action: the project lands under the host's configured projects
   * root. No destination is sent, so the host resolves the path — and a name
   * already taken there gets a suffix instead of an error.
   */
  async submit(): Promise<string | null> {
    return this.clone()
  }

  /** The secondary action's follow-through: clone into the folder that was picked. */
  cloneInto(parentDirectory: string): Promise<string | null> {
    const name = this.projectName
    if (!name) return Promise.resolve(null)
    return this.clone({ destination: joinHostPath(parentDirectory, name, this.platform) })
  }

  /** Resolves to the host-absolute path, so the caller can start a session there. */
  async clone(options: { destination?: string; clean?: boolean } = {}): Promise<string | null> {
    const api = this.api()
    const cloneUrl = this.cloneUrl
    if (!api || !cloneUrl || this.cloneStatus === 'running') return null

    const destination = options.destination ?? this.lastCloneDestination
    this.lastCloneDestination = destination
    this.cloneStatus = 'running'
    // A clone gets the whole panel while it runs, and hands it back to the form
    // it came from if it fails — that is where retry and adopt live.
    this.step = 'cloning'
    this.cloneError = null
    this.clonedPath = null
    this.cloneAuth = null
    this.logLines.length = 0
    try {
      const result = await api.setupCloneProject({
        cloneUrl,
        name: this.projectName ?? undefined,
        destination,
        protocol: this.protocol,
        clean: options.clean,
      })
      this.cloneStatus = 'done'
      this.clonedPath = result.path
      this.cloneAuth = result.auth
      this.partialPath = null
      return result.path
    } catch (err) {
      this.cloneStatus = 'failed'
      this.step = 'destination'
      this.cloneError = messageFor(err)
      this.partialPath = destination ?? this.destinationPreview
      return null
    }
  }

  /** Retries the clone that failed, at the same destination it chose the first time. */
  retryClone(options: { clean?: boolean } = {}): Promise<string | null> {
    return this.clone({ destination: this.lastCloneDestination, clean: options.clean })
  }

  /**
   * The other half of a refused clone: the host already has the checkout, so it
   * gets registered instead of cloned. The clone URL comes along so the host can
   * refuse a folder that turns out to be a different repository.
   */
  async adoptOccupiedDestination(): Promise<string | null> {
    const api = this.api()
    const path = this.partialPath
    if (!api || !path || this.adoptingProject) return null
    this.adoptingProject = true
    this.cloneError = null
    try {
      const result = await api.setupAdoptProject({ path, cloneUrl: this.cloneUrl ?? undefined })
      this.cloneStatus = 'done'
      this.clonedPath = result.path
      this.partialPath = null
      // Adoption says nothing about credentials — whatever the existing checkout
      // was cloned with is not this flow's to claim.
      this.cloneAuth = null
      return result.path
    } catch (err) {
      this.cloneError = messageFor(err)
      return null
    } finally {
      this.adoptingProject = false
    }
  }

  // ── Host repairs ────────────────────────────────────────────────────────────

  async installGit(): Promise<void> {
    await this.runRepair('installingGit', async (api) => {
      this.logLines.length = 0
      await api.setupInstallGit()
    })
  }

  async setGitIdentity(identity: GitCommitIdentity): Promise<void> {
    await this.runRepair('savingIdentity', (api) => api.setupSetGitIdentity(identity))
  }

  async installAgentCli(agent: SetupAgent): Promise<void> {
    await this.runRepair('installingAgent', async (api) => {
      this.logLines.length = 0
      await api.setupInstallAgentCli({ agent })
    })
  }

  async connectGithub(): Promise<void> {
    await this.runRepair('connectingGithub', async (api) => {
      try {
        const status = await api.providerConnect(hostProviderContext())
        if (status.connected) this.reposConnected = true
      } finally {
        this.deviceCode = null
      }
    })
    await this.loadRepos()
  }

  async cancelGithubConnect(): Promise<void> {
    const api = this.api()
    if (!api || !this.connectingGithub) return
    this.deviceCode = null
    await api.providerCancelConnect(hostProviderContext()).catch(() => {})
  }

  async authorizeGhCli(): Promise<void> {
    await this.runRepair('authorizingGhCli', (api) => api.setupAuthorizeGhCli())
  }

  async installCredentialHelper(): Promise<void> {
    await this.runRepair('installingCredentialHelper', (api) => api.setupInstallGitCredentialHelper())
  }

  async checkSshAccess(host?: string): Promise<void> {
    const api = this.api()
    if (!api) return
    this.checkingSshAccess = true
    this.actionError = null
    try {
      this.sshAccess = await api.setupCheckSshAccess({ host })
    } catch (err) {
      this.actionError = messageFor(err)
    } finally {
      this.checkingSshAccess = false
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private bindHost(host: HostOption): void {
    if (this.serverId !== host.id) this.resetHostData()
    this.serverId = host.id
    this.hostLabel = host.label
    this.hostIsLocal = host.local
    this.hostSeenBefore = markHostSeen(host.id)
    this.subscribe(host.id)
  }

  private api(): SolusAPI | null {
    return this.serverId ? this.resolveApi(this.serverId) : null
  }

  private async runRepair(flag: RepairFlag, action: (api: SolusAPI) => Promise<unknown>): Promise<void> {
    const api = this.api()
    if (!api || this[flag]) return
    this[flag] = true
    this.actionError = null
    try {
      await action(api)
    } catch (err) {
      this.actionError = messageFor(err)
    } finally {
      this[flag] = false
      // Every repair exists to change readiness, so re-probe rather than guess.
      await this.refreshReadiness()
    }
  }

  private subscribe(serverId: string): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe()
    const api = this.resolveApi(serverId)
    this.unsubscribes = [
      // The host runs one setup step at a time, so a single output pane can
      // carry whichever one the dialog started without interleaving.
      api.onSetupLog((event: SetupLogEvent) => {
        this.logLines.push(event.line)
        if (this.logLines.length > LOG_LIMIT) this.logLines.splice(0, this.logLines.length - LOG_LIMIT)
      }),
      api.onSetupStatus((event: SetupStatusEvent) => {
        if (event.step !== 'clone') return
        if (event.status === 'running') this.cloneStatus = 'running'
      }),
      api.onProviderDeviceCode((prompt: DeviceCodePrompt) => {
        this.deviceCode = prompt
      }),
    ]
  }

  /**
   * Everything that describes one host, dropped when the flow moves to another.
   * The in-flight flags go with it: the requests they guard are now answering
   * about the wrong machine, and every loader drops a reply that outlived its
   * host rather than painting it over the new one.
   */
  private resetHostData(): void {
    this.readiness = null
    this.readinessError = null
    this.readinessLoading = false
    this.capabilities = null
    this.recents = []
    this.recentsLoading = false
    this.repos = []
    this.reposLoading = false
    this.reposConnected = null
    this.reposError = null
    this.selectedRepoFullName = null
    this.deviceCode = null
    this.sshAccess = null
    this.actionError = null
    this.logLines = []
    this.cloneStatus = 'idle'
    this.cloneError = null
    this.clonedPath = null
    this.cloneAuth = null
    this.partialPath = null
    this.lastCloneDestination = undefined
  }

  private reset(): void {
    this.resetHostData()
    this.protocol = 'https'
    this.homeQuery = ''
    for (const unsubscribe of this.unsubscribes) unsubscribe()
    this.unsubscribes = []
  }
}

type RepairFlag =
  | 'installingGit'
  | 'savingIdentity'
  | 'connectingGithub'
  | 'authorizingGhCli'
  | 'installingCredentialHelper'
  | 'installingAgent'

/**
 * `providerConnect` only reads the session's directory, to pick a provider for
 * that repo's host. There is no session on the host being prepared, so an empty
 * directory is passed deliberately: the handler then falls back to GitHub.
 */
function hostProviderContext(): IpcContext {
  return { session: { projectPath: '', workingDirectory: '' } } as unknown as IpcContext
}

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Returns whether this host was already known, and records it either way. */
function markHostSeen(serverId: string): boolean {
  try {
    const stored = JSON.parse(localStorage.getItem(SEEN_HOSTS_KEY) ?? '[]') as unknown
    const seen = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []
    if (seen.includes(serverId)) return true
    localStorage.setItem(SEEN_HOSTS_KEY, JSON.stringify([...seen, serverId]))
    return false
  } catch {
    return true
  }
}

export const openProjectStore = new OpenProjectStore()
