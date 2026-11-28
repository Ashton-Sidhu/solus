import { cloudAccount } from '@solus/client-core/cloud-account'
import { localApi } from '@solus/client-core/local-api'
import { LOCAL_SERVER_ID } from '@solus/client-core/known-host'
import { serverConnections } from '@solus/client-core/server-connections'
import { SvelteSet } from 'svelte/reactivity'
import { accountStore, projectsStore, serversStore, uplinkStore } from '../../contexts'
import { cloudAgentSeatsStore } from '../../contexts/seats/cloud-agent-seats.store.svelte'
import type { WorkspaceContext } from '../../contexts/workspace/workspace.context.svelte'
import { SETUP_PROVIDERS, seatProviderFor } from '../servers/lib/host-onboarding'
import { hostSetupStore, type HostSetupSession } from '../servers/host-setup.store.svelte'
import { agentHistoryStore } from './agent-history.store.svelte'
import { cloudOnboardingStore as cloud } from './cloud-onboarding.store.svelte'
import { defaultSize, machineStepProgress, machineTargets, newCloudHostRequest, reachability, type MachineTargets } from './lib/cloud-compute'
import {
  defaultCheckedProjects,
  footerFor,
  isAlreadyDone,
  nextOpenStep,
  progressLine,
  skipEffect,
  stepsFor,
  timeline,
  type AlreadyDoneFacts,
  type Footer,
  type OnboardingFlow,
  type OnboardingStep,
  type SetupChoice,
  type TimelineEntry,
} from './lib/onboarding-model'
import { repositoryName } from './lib/repository-preparation'
import type { StepCopyFacts } from './lib/step-copy'

/** What the page does once the flow ends: where the person lands. */
export type OnboardingEnd = 'stay' | 'finish'

/**
 * The one place first-run onboarding keeps its own state: the flow, the open
 * step, what is done, and the person's choices on the page. Everything the
 * steps report (agent logins, hosts, the account) is read off the stores that
 * already own it, so onboarding cannot disagree with Settings.
 *
 * Completion is a client preference on desktop and web paired to a host, and
 * belongs to the account in the cloud flow; the page records it when it ends.
 */
class OnboardingStore {
  flow = $state<OnboardingFlow>('host')
  /** The account is preselected (decision 3). */
  choice = $state<SetupChoice>('account')
  /** The open step; null in the cloud flow's ready state. */
  open = $state<OnboardingStep | null>(null)
  readonly done = new SvelteSet<OnboardingStep>()
  /** The Draw intro is over the page (decision 8). */
  showsIntro = $state(false)
  /** The primary action of the open step runs. */
  isBusy = $state(false)
  /** Why the last browser sign-in ended without an account. */
  signInError = $state<string | null>(null)

  /** Folder paths to add as projects; the recent ones are checked when the history arrives. */
  readonly checkedProjects = new SvelteSet<string>()
  /** Folders chosen with "Open another folder", listed after the history. */
  otherFolders = $state<string[]>([])
  private hasSeededProjects = false
  /** Steps that opened folded as done, because nothing was left to do in them (`isAlreadyDone`). */
  readonly folded = new SvelteSet<OnboardingStep>()

  /** Cloud step 1 as the person picked it; null follows the default. */
  private pickedMachineTarget = $state<'cloud' | 'own' | null>(null)
  /** The size of a new cloud host; null is the catalog's default. */
  sizeId = $state<string | null>(null)

  /**
   * The one host the steps ask about. Desktop and a paired browser ask the
   * host this client works against; the cloud flow asks the machine the person
   * chose. Empty when the cloud flow has no machine yet.
   */
  get serverId(): string {
    if (this.flow === 'cloud') return cloud.chosenServerId ?? ''
    return serverConnections.runOnHostId() ?? serversStore.activeServerId
  }

  /** The install-and-sign-in engine for the bound host, shared with Settings. */
  get setup(): HostSetupSession {
    return hostSetupStore.sessionFor(this.serverId)
  }

  get steps(): OnboardingStep[] {
    return stepsFor(this.flow, this.choice)
  }

  /** The desktop browser sign-in this page started is open. */
  get signingIn(): boolean {
    return this.flow === 'desktop' && accountStore.state.kind === 'signing-in'
  }

  /** The cloud flow's last screen: every step done, and Start in the repository. */
  get isReady(): boolean {
    return this.flow === 'cloud' && this.open === null
  }

  /** Where cloud step 1's background work is: the cloud host starting, a computer linking. */
  private get machineProgress(): 'working' | 'failed' | 'settled' {
    if (this.flow !== 'cloud') return 'settled'
    return machineStepProgress({
      host: cloud.chosenHost,
      isBusy: !!cloud.hostBusy,
      hasError: !!cloud.hostError || !!cloud.linkError,
      isLinking: this.machineTarget === 'own' && !!cloud.linkCode && !cloud.chosenServerId,
    })
  }

  /** Steps whose work goes on while the person finishes. */
  get working(): ReadonlySet<OnboardingStep> {
    return new Set<OnboardingStep>(this.machineProgress === 'working' ? ['machine'] : [])
  }

  /** Steps whose background work failed: the marker says so instead of spinning. */
  get failed(): ReadonlySet<OnboardingStep> {
    return new Set<OnboardingStep>(this.machineProgress === 'failed' ? ['machine'] : [])
  }

  get timeline(): TimelineEntry[] {
    return timeline({ steps: this.steps, open: this.open, done: this.done, working: this.working, failed: this.failed, signingIn: this.signingIn })
  }

  get progress(): string {
    return progressLine(this.steps, this.open)
  }

  /** The agents ready to take a turn: the host's own logins, or the account's seats in the cloud. */
  get readyAgents(): number {
    return SETUP_PROVIDERS.filter(({ id }) => this.isAgentReady(id)).length
  }

  /** A sign-in that waits on the browser, by its provider's name. */
  get pendingAgent(): string | null {
    if (this.flow === 'cloud') return null
    return SETUP_PROVIDERS.find(({ id }) => this.setup.verificationFor(id))?.label ?? null
  }

  /** The first checked folder, which the workspace opens in. */
  get landingProjectPath(): string | null {
    const history = (agentHistoryStore.projects ?? []).map((project) => project.path)
    return [...history, ...this.otherFolders].find((path) => this.checkedProjects.has(path)) ?? null
  }

  /** What the timeline's words depend on (`stepCopy`). */
  get copyFacts(): StepCopyFacts {
    const ready = SETUP_PROVIDERS.filter(({ id }) => this.isAgentReady(id)).map(({ label }) => label)
    const later = SETUP_PROVIDERS.map(({ label }) => label).filter((label) => !ready.includes(label))
    const history = agentHistoryStore.projects ?? []
    const projectNames = [...history.map((project) => project.path), ...this.otherFolders]
      .filter((path) => this.checkedProjects.has(path))
      .map(folderName)
    const state = accountStore.state
    return {
      flow: this.flow,
      choice: this.choice,
      email: state.kind === 'signed-in' ? state.identity.email : null,
      machineNoun: this.flow === 'desktop' && localApi.getPlatform() === 'darwin' ? 'Mac' : 'computer',
      readyAgentNames: ready,
      laterAgentNames: later,
      projectNames,
      machine: { target: this.machineTarget, isWorking: this.working.has('machine'), summary: this.machineSummary },
      repository: cloud.chosenRepositoryKey,
      folded: this.folded,
    }
  }

  private isAgentReady(agent: (typeof SETUP_PROVIDERS)[number]['id']): boolean {
    if (this.flow === 'cloud') return cloudAgentSeatsStore.connected(seatProviderFor(agent)) === true
    return this.setup.readiness?.agents?.[agent]?.signedIn === true
  }

  /** The folded line of cloud step 1, which keeps moving while the host starts. */
  private get machineSummary(): string {
    if (cloud.hostError) return cloud.hostError
    const host = cloud.chosenHost
    if (this.machineTarget === 'own') {
      if (host) return host.readiness === 'ready' ? `${host.label} · linked` : `${host.label} · connecting`
      return cloud.linkCode ? 'Waiting for it to link' : 'Not linked yet'
    }
    if (cloud.hostBusy === 'creating') return 'Starting in the background · about a minute'
    // Skipped, or the create was refused before it started: nothing runs.
    if (!host) return 'Not set up yet'
    if (host.readiness === 'ready') return 'Running'
    if (this.machineProgress === 'failed') return `${host.label} · ${reachability(host)}`
    return 'Starting in the background · about a minute'
  }

  get footer(): Footer {
    const landing = this.landingProjectPath
    return footerFor(this.open, {
      choice: this.choice,
      signingIn: this.signingIn,
      signedIn: accountStore.isSignedIn,
      readyAgents: this.readyAgents,
      pendingAgent: this.pendingAgent,
      checkedProjects: this.checkedProjects.size,
      landingProject: landing ? folderName(landing) : null,
      machineTarget: this.machineTarget,
      machineOffered: this.machineTargets[this.machineTarget],
      hasCloudHost: !!cloud.choices.cloudHost,
      hasLinkCommand: !!cloud.linkCode || !!this.ownMachine,
      githubConnected: !!cloud.account?.github,
      repositoryName: cloud.chosenRepositoryKey ? repositoryName(cloud.chosenRepositoryKey) : null,
      isBusy: this.isBusy || !!cloud.repositoryPreparation,
    })
  }

  // ── Starting ──────────────────────────────────────────────────────────────

  start(): void {
    this.flow = cloudAccount() ? 'cloud' : accountStore.isAvailable ? 'desktop' : 'host'
    this.choice = 'account'
    this.done.clear()
    this.folded.clear()
    this.signInError = null
    this.isBusy = false
    this.showsIntro = false
    this.checkedProjects.clear()
    this.otherFolders = []
    this.hasSeededProjects = false
    this.pickedMachineTarget = null
    if (this.flow === 'desktop') accountStore.start()
    // Reopened from a "Get started" item: that step opens, the ones before it count as done.
    const reopenedAt = this.flow === 'cloud' ? cloud.reopenedAt : null
    if (reopenedAt) {
      for (const step of this.steps.slice(0, this.steps.indexOf(reopenedAt))) this.done.add(step)
      this.open = reopenedAt
      return
    }
    this.showsIntro = this.flow === 'desktop' && !prefersReducedMotion()
    // The facts that fold a step are read now, so a later step usually finds them answered.
    if (this.flow === 'cloud') cloud.refreshGetStarted()
    else {
      void this.setup.refreshReadiness()
      void agentHistoryStore.load(this.serverId)
      if (this.flow === 'desktop') void uplinkStore.refresh(LOCAL_SERVER_ID)
    }
    this.openNextStep()
  }

  endIntro(): void {
    this.showsIntro = false
  }

  // ── Moving through the timeline ─────────────────────────────────────────────

  /** Marks the step done and opens the next one. The end of a desktop flow finishes it. */
  private complete(step: OnboardingStep): OnboardingEnd {
    this.done.add(step)
    this.folded.delete(step)
    this.openNextStep()
    return this.open === null && this.flow !== 'cloud' ? 'finish' : 'stay'
  }

  /** Opens the first step not done; a step with nothing left to do folds as done on the way. */
  private openNextStep(): void {
    const facts = this.alreadyDoneFacts
    let next = nextOpenStep(this.steps, this.done)
    while (next && isAlreadyDone(next, facts)) {
      // Like Skip: the person lands on the machine the account already has.
      if (next === 'machine') cloud.chooseDefaultHost()
      this.done.add(next)
      this.folded.add(next)
      next = nextOpenStep(this.steps, this.done)
    }
    this.open = next
  }

  private get alreadyDoneFacts(): AlreadyDoneFacts {
    const cloudFacts = cloud.getStartedFacts
    return {
      flow: this.flow,
      isSignedIn: accountStore.isSignedIn,
      hasEveryHostAgent: this.flow !== 'cloud' && SETUP_PROVIDERS.every(({ id }) => this.isAgentReady(id)),
      history: agentHistoryStore.serverId === this.serverId ? agentHistoryStore.projects : null,
      now: Date.now(),
      isLinked: uplinkStore.statusFor(LOCAL_SERVER_ID)?.link.linked === true,
      hasMachine: cloudFacts.hasMachine,
      hasAccountAgent: cloudFacts.hasSignedInAgent === true,
      hasCloudProject: cloudFacts.githubConnected === true && cloudFacts.hasProject === true,
    }
  }

  /** Edit or Change on a folded step opens it again; the steps after it keep what they had. */
  edit(step: OnboardingStep): void {
    if (this.signingIn || this.isBusy) return
    this.open = step
  }

  chooseSetup(choice: SetupChoice): void {
    this.choice = choice
    this.signInError = null
  }

  /** "Use This Mac only instead": leaves the browser sign-in and keeps the setup here. */
  useThisMacOnly(): void {
    if (this.signingIn) accountStore.cancelSignIn()
    this.choice = 'local'
    this.signInError = null
    this.complete('setup')
  }

  /** The open step's one primary action, which Enter also runs. */
  async primary(workspace: Pick<WorkspaceContext, 'opening'>): Promise<OnboardingEnd> {
    const step = this.open
    if (this.isBusy || !this.footer.primaryEnabled) return 'stay'
    if (step === null) return 'finish'
    this.isBusy = true
    try {
      return await this.runPrimary(step, workspace)
    } finally {
      this.isBusy = false
    }
  }

  private async runPrimary(step: OnboardingStep, workspace: Pick<WorkspaceContext, 'opening'>): Promise<OnboardingEnd> {
    switch (step) {
      case 'setup':
        if (this.choice === 'account' && !accountStore.isSignedIn) return this.signIn()
        return this.complete('setup')
      case 'projects':
        this.addCheckedProjects()
        return this.complete('projects')
      case 'machine':
        return this.continueWithMachine()
      case 'code':
        if (!cloud.account?.github) {
          openAccountConnections()
          return 'stay'
        }
        if (!cloud.chosenRepositoryKey) return 'stay'
        if (!(await cloud.chooseRepository(cloud.chosenRepositoryKey))) return 'stay'
        if (!(await cloud.prepareChosenRepository(workspace))) return 'stay'
        return this.complete('code')
      default:
        return this.complete(step)
    }
  }

  /** Skip, which Escape also runs. On step 1 it keeps everything on this machine. */
  skip(): OnboardingEnd {
    const step = this.open
    if (this.isBusy || step === null) return step === null ? 'finish' : 'stay'
    if (skipEffect(step) === 'choose-local') {
      this.useThisMacOnly()
      return 'stay'
    }
    // "Or start with an empty project": the cloud flow ends without a repository.
    if (step === 'code') {
      cloud.chosenRepositoryKey = null
      return 'finish'
    }
    // Skipped projects are not added, so the workspace does not open in one.
    if (step === 'projects') this.checkedProjects.clear()
    // Without a choice, the machine the person lands on is the default one.
    if (step === 'machine') cloud.chooseDefaultHost()
    return this.complete(step)
  }

  private async signIn(): Promise<OnboardingEnd> {
    this.signInError = null
    const ended = await accountStore.signIn()
    // "Use This Mac only instead" already moved on.
    if (this.choice !== 'account' || this.open !== 'setup') return 'stay'
    if (ended === 'approved') return this.complete('setup')
    if (ended === 'denied') this.signInError = 'The sign-in was declined in the browser. Try again, or use This Mac only.'
    else if (ended === 'error') this.signInError = 'Solus could not finish the sign-in. Try again, or use This Mac only.'
    return 'stay'
  }

  /** Opens the browser sign-in page again, for a window that closed or never came up. */
  reopenSignInPage(): void {
    const state = accountStore.state
    if (state.kind === 'signing-in') void localApi.openExternal(state.authorizeUrl)
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  /** Reads the host's agent history, and checks the recent folders the first time it answers. */
  async loadProjects(): Promise<void> {
    await agentHistoryStore.load(this.serverId)
    const projects = agentHistoryStore.projects
    if (!projects || this.hasSeededProjects) return
    this.hasSeededProjects = true
    for (const path of defaultCheckedProjects(projects, Date.now())) this.checkedProjects.add(path)
  }

  toggleProject(path: string): void {
    if (this.checkedProjects.has(path)) this.checkedProjects.delete(path)
    else this.checkedProjects.add(path)
  }

  /** "Open another folder": listed and checked. */
  addOtherFolder(path: string): void {
    if (!this.otherFolders.includes(path)) this.otherFolders.push(path)
    this.checkedProjects.add(path)
  }

  private addCheckedProjects(): void {
    const serverId = this.serverId
    if (!serverId) return
    const known = new Set((agentHistoryStore.projects ?? []).filter((project) => project.isProject).map((project) => project.path))
    const api = serverConnections.apiFor(serverId)
    for (const path of this.checkedProjects) {
      if (!known.has(path)) projectsStore.addProject(serverId, api, path)
    }
  }

  // ── Cloud: where the agents run ─────────────────────────────────────────────

  /**
   * The cloud host starts in the background, so the person goes on at once
   * and the step's marker spins until it answers (decision 1). A computer of
   * their own is linked with one command; its step spins until it links.
   */
  private async continueWithMachine(): Promise<OnboardingEnd> {
    if (this.machineTarget === 'own') {
      if (!this.machineTargets.own) return 'stay'
      const own = this.ownMachine
      if (own) {
        cloud.choose(own.id)
        if (own.readiness !== 'ready') void cloud.reachHost(own.id)
        return this.complete('machine')
      }
      if (!cloud.linkCode) {
        await cloud.requestLinkCode()
        return 'stay'
      }
      return this.complete('machine')
    }
    if (!this.machineTargets.cloud) return 'stay'
    const host = cloud.choices.cloudHost
    if (host) {
      cloud.choose(host.id)
      if (host.readiness !== 'ready') void cloud.reachHost(host.id)
    } else {
      void this.createCloudHost()
    }
    return this.complete('machine')
  }

  /** The choices of cloud step 1 the organization offers. */
  get machineTargets(): MachineTargets {
    return machineTargets(cloud.choices, cloud.organization, cloud.managedHostCatalog)
  }

  /** Cloud step 1: the organization's cloud host, preselected when it is offered, or the person's own computer. */
  get machineTarget(): 'cloud' | 'own' {
    const targets = this.machineTargets
    const picked = this.pickedMachineTarget
    if (picked && targets[picked]) return picked
    return targets.cloud || !targets.own ? 'cloud' : 'own'
  }

  chooseMachineTarget(target: 'cloud' | 'own'): void {
    this.pickedMachineTarget = target
  }

  /** A computer this account linked or another member shared: "Your own computer" uses it, with no command. */
  get ownMachine() {
    const { ownMachines, sharedMachines } = cloud.choices
    return ownMachines[0] ?? sharedMachines[0] ?? null
  }

  private async createCloudHost(): Promise<void> {
    const catalog = cloud.managedHostCatalog
    const size = catalog?.sizes.find((entry) => entry.id === this.sizeId) ?? defaultSize(catalog)
    const request = newCloudHostRequest({ name: '', size, packages: '', setupScript: '' }, cloud.organization, catalog)
    if (!request.ok) return
    await cloud.createCloudHost({ label: request.label, spec: request.spec })
    const created = cloud.chosenHost
    if (created && created.readiness !== 'ready') await cloud.reachHost(created.id)
  }
}

function folderName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

/** GitHub and the other connections belong to the account; its Connections page opens in a new tab. */
export function openAccountConnections(): void {
  const url = cloudAccount()?.connectionsUrl
  if (url) void localApi.openExternal(url)
}

export const onboardingStore = new OnboardingStore()
