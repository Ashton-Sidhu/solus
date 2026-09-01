import { serverConnections } from '@solus/client-core/server-connections'
import type { SolusAPI } from '@solus/contracts/host-api'
import type {
  CloneAuth,
  CloneProtocol,
  HostReadiness,
  RecentProject,
  ServerCapabilities,
  SetupGithubRepo,
  SetupSshAccessResult,
} from '@solus/contracts/types'
import { serversStore } from '../../contexts'
import { hostSetupStore, type HostSetupSession } from './host-setup.store.svelte'
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
import { messageFor } from './lib/setup-rpc'

/**
 * The Open project flow: one home screen — a recent project, a folder, GitHub,
 * a URL — and the machine it all lands on, bound on open and changed from the
 * header chip rather than from a step of its own.
 *
 * Every call resolves the API for `serverId` — `window.solus` never appears
 * here, because the host being opened on is often not the active one. Callers
 * hand it the host list at the moment they open it, ordered
 * active-machine-first, and the first entry becomes the default.
 */

/** How many recent projects home offers before the three actions take over. */
const HOME_RECENTS_LIMIT = 3

export type CloneStatus = 'idle' | 'running' | 'done' | 'failed'

export interface OpenProjectOptions {
  /** The tab or draft a successful open retargets at the project. */
  tabId?: string
  /** A visible project page owns the result instead of opening a composer. */
  onProjectOpened?: (project: { serverId: string; projectRoot: string }) => void
  /** The machine to bind, instead of the first one in the host list. */
  host?: HostOption
  /** Prefills the clone box — e.g. the repo the current tab is in. */
  seed?: string
  /** Skips home for entry points that already know what is being opened. */
  source?: ProjectSource
}

type ProjectOpenedCallback = NonNullable<OpenProjectOptions['onProjectOpened']>

type ResolveApi = (serverId: string) => SolusAPI
type SessionFor = (serverId: string) => HostSetupSession
type RecentProjectsFor = (serverId: string) => Promise<RecentProject[]>

export class OpenProjectStore {
  isOpen = $state(false)
  step = $state<OpenProjectStep>('home')
  source = $state<ProjectSource | null>(null)

  serverId = $state<string | null>(null)
  hostLabel = $state('')
  hostIsLocal = $state(true)
  tabId = $state<string | null>(null)
  onProjectOpened: ProjectOpenedCallback | null = null

  /** The agent half of readiness: whether this host can actually run a session. */
  capabilities = $state<ServerCapabilities | null>(null)

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

  cloneStatus = $state<CloneStatus>('idle')
  cloneError = $state<string | null>(null)
  clonedPath = $state<string | null>(null)
  /** The directory a failed clone left behind, so retry can offer to remove it. */
  partialPath = $state<string | null>(null)
  /** How the last clone authenticated — the only thing that says whether this host can also push. */
  cloneAuth = $state<CloneAuth | null>(null)
  adoptingProject = $state(false)

  sshAccess = $state<SetupSshAccessResult | null>(null)

  private readonly resolveApi: ResolveApi
  private readonly sessionFor: SessionFor
  private readonly recentProjectsFor: RecentProjectsFor
  private retainedSetup: HostSetupSession | null = null
  /** Set by whichever action started a clone, so a retry lands in the same place. */
  private lastCloneDestination: string | undefined = undefined
  /**
   * Bumped whenever the host data is dropped — on rebind and on reopen. Every
   * await compares against it afterwards, so a reply that outlived its binding
   * is dropped instead of painting one host's answer (or clone!) onto another.
   * Comparing `serverId` is not enough: a switch away and back, or a close and
   * reopen, rebinds the same id while every in-flight reply has gone stale.
   */
  private hostEpoch = 0

  constructor(
    resolveApi: ResolveApi = (serverId) => serverConnections.apiFor(serverId),
    sessionFor: SessionFor = (serverId) => hostSetupStore.sessionFor(serverId),
    recentProjectsFor: RecentProjectsFor = (serverId) => serversStore.recentProjectsFor(serverId),
  ) {
    this.resolveApi = resolveApi
    this.sessionFor = sessionFor
    this.recentProjectsFor = recentProjectsFor
  }

  // ── What the current step commits to ────────────────────────────────────────

  get setup(): HostSetupSession | null {
    return this.retainedSetup
  }

  get readiness(): HostReadiness | null {
    return this.setup?.readiness ?? null
  }

  get readinessLoading(): boolean {
    return this.setup?.readinessLoading ?? false
  }

  get readinessError(): string | null {
    return this.setup?.readinessError ?? null
  }

  get logLines(): string[] {
    return this.setup?.logLines ?? []
  }

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
    return this.protocol === 'ssh' && (this.readiness?.ssh?.publicKeys.length ?? 0) === 0
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
    this.onProjectOpened = options.onProjectOpened ?? null
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

  /** Records that home opened an existing folder before the caller adopts it. */
  openRecent(): void {
    this.source = 'local'
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

  selectRepo(fullName: string): void {
    this.selectedRepoFullName = fullName
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
      if (this.setup) this.setup.logLines.length = 0
      this.cloneStatus = 'idle'
    }
    this.step = 'home'
  }

  close(): void {
    this.isOpen = false
    this.retainedSetup?.release()
    this.retainedSetup = null
  }

  // ── Host data ───────────────────────────────────────────────────────────────

  async refreshReadiness(): Promise<void> {
    const api = this.api()
    const setup = this.setup
    if (!api || !setup) return
    const issuedAt = this.hostEpoch
    const [, capabilities] = await Promise.all([
      setup.refreshReadiness(),
      api.getServerCapabilities().catch(() => null),
    ])
    if (this.hostEpoch !== issuedAt) return
    this.capabilities = capabilities
    if (this.reposConnected === null && setup.readiness?.github?.solusToken) {
      this.reposConnected = true
    }
  }

  /** Home's recents, per host — nothing about them carries across machines. */
  async loadRecents(): Promise<void> {
    const serverId = this.serverId
    if (!serverId) return
    const issuedAt = this.hostEpoch
    this.recentsLoading = true
    try {
      const recents = await this.recentProjectsFor(serverId)
      if (this.hostEpoch === issuedAt) this.recents = recents
    } catch {
      // Home still offers the three actions; an unreachable host just has
      // nothing to list, which the empty state already says.
      if (this.hostEpoch === issuedAt) this.recents = []
    } finally {
      if (this.hostEpoch === issuedAt) this.recentsLoading = false
    }
  }

  async loadRepos(): Promise<void> {
    const api = this.api()
    if (!api || this.reposLoading) return
    const issuedAt = this.hostEpoch
    this.reposLoading = true
    this.reposError = null
    try {
      const result = await api.setupListGithubRepos()
      if (this.hostEpoch !== issuedAt) return
      this.reposConnected = result.connected
      this.repos = result.connected ? result.repos : []
    } catch (err) {
      // A disconnected response is the only evidence that credentials are
      // missing. Network/server failures must not overwrite a known sign-in
      // with the much more alarming "Connect GitHub" state.
      if (this.hostEpoch !== issuedAt) return
      this.reposError = messageFor(err)
      this.repos = []
    } finally {
      if (this.hostEpoch === issuedAt) this.reposLoading = false
    }
  }

  // ── Committing ──────────────────────────────────────────────────────────────

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
    const issuedAt = this.hostEpoch

    const destination = options.destination ?? this.lastCloneDestination
    this.lastCloneDestination = destination
    this.cloneStatus = 'running'
    // A clone gets the whole panel while it runs, and hands it back to the form
    // it came from if it fails — that is where retry and adopt live.
    this.step = 'cloning'
    this.cloneError = null
    this.clonedPath = null
    this.cloneAuth = null
    if (this.setup) this.setup.logLines.length = 0
    try {
      const result = await api.setupCloneProject({
        cloneUrl,
        name: this.projectName ?? undefined,
        destination,
        protocol: this.protocol,
        clean: options.clean,
      })
      // The dialog was reopened (and possibly rebound) while this ran; the
      // result belongs to a binding that no longer exists, so nobody gets it.
      if (this.hostEpoch !== issuedAt) return null
      this.cloneStatus = 'done'
      this.clonedPath = result.path
      this.cloneAuth = result.auth
      this.partialPath = null
      return result.path
    } catch (err) {
      if (this.hostEpoch !== issuedAt) return null
      this.cloneStatus = 'failed'
      this.step = 'destination'
      this.cloneError = messageFor(err)
      this.partialPath = destination ?? this.destinationPreview
      return null
    }
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
    const issuedAt = this.hostEpoch
    this.adoptingProject = true
    this.cloneError = null
    try {
      const result = await api.setupAdoptProject({ path, cloneUrl: this.cloneUrl ?? undefined })
      if (this.hostEpoch !== issuedAt) return null
      this.cloneStatus = 'done'
      this.clonedPath = result.path
      this.partialPath = null
      // Adoption says nothing about credentials — whatever the existing checkout
      // was cloned with is not this flow's to claim.
      this.cloneAuth = null
      return result.path
    } catch (err) {
      if (this.hostEpoch !== issuedAt) return null
      this.cloneError = messageFor(err)
      return null
    } finally {
      if (this.hostEpoch === issuedAt) this.adoptingProject = false
    }
  }

  async checkSshAccess(): Promise<void> {
    const api = this.api()
    if (!api) return
    const issuedAt = this.hostEpoch
    try {
      const sshAccess = await api.setupCheckSshAccess({})
      if (this.hostEpoch !== issuedAt) return
      this.sshAccess = sshAccess
    } catch (err) {
      if (this.hostEpoch !== issuedAt) return
      this.sshAccess = { host: 'github.com', ok: false, message: messageFor(err) }
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private bindHost(host: HostOption): void {
    if (this.serverId !== host.id) this.resetHostData()
    this.serverId = host.id
    this.hostLabel = host.label
    this.hostIsLocal = host.local
    if (!this.retainedSetup) {
      this.retainedSetup = this.sessionFor(host.id)
      this.retainedSetup.retain()
    }
  }

  private api(): SolusAPI | null {
    return this.serverId ? this.resolveApi(this.serverId) : null
  }

  /**
   * Everything that describes one host, dropped when the flow moves to another.
   * Every loader drops a reply that outlived its host rather than painting it
   * over the new one.
   */
  private resetHostData(): void {
    this.hostEpoch++
    this.retainedSetup?.release()
    this.retainedSetup = null
    this.capabilities = null
    this.recents = []
    this.recentsLoading = false
    this.repos = []
    this.reposLoading = false
    this.reposConnected = null
    this.reposError = null
    this.selectedRepoFullName = null
    this.sshAccess = null
    this.cloneStatus = 'idle'
    this.cloneError = null
    this.clonedPath = null
    this.cloneAuth = null
    this.partialPath = null
    this.adoptingProject = false
    this.lastCloneDestination = undefined
  }

  private reset(): void {
    this.resetHostData()
    this.protocol = 'https'
    this.homeQuery = ''
    this.onProjectOpened = null
  }
}

export const openProjectStore = new OpenProjectStore()
