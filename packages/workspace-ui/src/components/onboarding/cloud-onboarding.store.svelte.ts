import { cloudAccount, startupAccountRead } from '@solus/client-core/cloud-account'
import { serverConnections } from '@solus/client-core/server-connections'
import { uplinkAccountSource } from '@solus/client-core/uplink-account'
import type { ProviderRepository } from '@solus/contracts/providers'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import type {
  AccountOrganization,
  AccountResponse,
  ManagedHostCatalog,
  ManagedHostSpecRequest,
  UplinkEnrollmentTicket,
} from '@solus/contracts/uplink'
import { serversStore, workspaceProjectsStore } from '../../contexts'
import {
  computeChoices,
  createHostFailureMessage,
  defaultComputeHost,
  type ComputeChoices,
} from './lib/cloud-compute'
import { awaitsManagedCompute, managedHostNeedsStart } from '@solus/client-core/server-registry'
import type { ServerItem } from '../../contexts/connections/servers.store.svelte'
import type { WorkspaceContext } from '../../contexts/workspace/workspace.context.svelte'
import type { OnboardingStage } from './lib/onboarding-model'
import type { GetStartedFacts } from './lib/get-started'
import { cloudAgentSeatsStore } from '../../contexts/seats/cloud-agent-seats.store.svelte'
import { ensureRepositoryCheckout, type CheckoutStep } from '../../contexts/workspace/repository-checkout'

/** How often the directory is read while a link code waits for its machine. */
const LINK_POLL_MS = 3_000

/**
 * What cloud onboarding keeps while it runs (docs/plans/cloud-onboarding.md §3):
 * the account's answer from Solus Cloud, the machine chosen for agents, and the
 * repository the flow ends in. Hosts, projects and GitHub status are read off
 * the stores that own them, so this flow cannot disagree with Settings.
 */
class CloudOnboardingStore {
  account = $state<AccountResponse | null>(null)
  accountLoaded = $state(false)

  /** The machine agents run on; null when the person chose "Not now". */
  chosenServerId = $state<string | null>(null)
  private hasChosen = false

  /** `starting` asks a stopped host to run; `connecting` only waits for this client to reach it. */
  hostBusy = $state<'creating' | 'starting' | 'connecting' | null>(null)
  hostError = $state<string | null>(null)

  linkCode = $state<UplinkEnrollmentTicket | null>(null)
  linkError = $state<string | null>(null)
  private linkPoll: ReturnType<typeof setInterval> | null = null

  sharingServerId = $state<string | null>(null)

  repositories = $state<ProviderRepository[] | null>(null)
  repositoriesError = $state<string | null>(null)
  addingRepositoryKey = $state<string | null>(null)
  /** The repository the flow ends in, once it is a project in Solus Cloud. */
  chosenRepositoryKey = $state<string | null>(null)
  /** Start makes the chosen repository a project on its machine before the
   *  draft opens; this is where that is, while it runs. */
  repositoryPreparation = $state<{ serverId: string; step: CheckoutStep } | null>(null)
  /** Why the last Start could not prepare the repository; Start tries again. */
  repositoryPreparationError = $state<string | null>(null)

  /** A "Get started" item reopened the flow at this stage; null when it is not reopened. */
  reopenedAt = $state<OnboardingStage | null>(null)

  /** Only the web client at a signed-in Solus Cloud origin has an account. */
  get isCloud(): boolean {
    return cloudAccount() !== null
  }

  /** Shown until the account finished or skipped it, on any device. */
  get needsOnboarding(): boolean {
    return this.accountLoaded && !!this.account && this.account.onboardingCompletedAt === null
  }

  /** Whether the onboarding surface is up: the first run, or an item reopened it. */
  get isOpen(): boolean {
    return this.needsOnboarding || this.reopenedAt !== null
  }

  /**
   * Opens the flow again at the stage that sets one "Get started" item.
   * Agent connections can be checked before a machine is chosen.
   */
  reopenAt(stage: OnboardingStage): void {
    this.reopenedAt = stage
  }

  get organization(): AccountOrganization | null {
    const account = this.account
    if (!account) return null
    return account.organizations.find((entry) => entry.organizationId === account.activeOrganizationId) ?? null
  }

  /** What "Runs on" and "Size" offer for a new cloud host; absent from an older Solus Cloud. */
  get managedHostCatalog(): ManagedHostCatalog | undefined {
    return this.account?.managedHostCatalog
  }

  get choices(): ComputeChoices<ServerItem> {
    return computeChoices(serversStore.servers, {
      userId: this.account?.userId ?? '',
      activeOrganizationId: this.account?.activeOrganizationId ?? null,
    })
  }

  get chosenHost(): ServerItem | null {
    return serversStore.servers.find((server) => server.id === this.chosenServerId) ?? null
  }

  /** The organization's workspace service: where projects live and GitHub is asked about. */
  get workspaceServerId(): string | null {
    return serversStore.activeCloudServerId
  }

  /** Every machine the account can run agents on, as the "Get started" list counts them. */
  get machines(): ServerItem[] {
    const { cloudHost, ownMachines, sharedMachines } = this.choices
    return [...(cloudHost ? [cloudHost] : []), ...ownMachines, ...sharedMachines]
  }

  /** The live facts behind the "Get started" list; unknown stays null until its store answers. */
  get getStartedFacts(): GetStartedFacts {
    const workspaceServerId = this.workspaceServerId
    const github = this.account?.github
    return {
      hasMachine: this.machines.length > 0,
      hasSignedInAgent: cloudAgentSeatsStore.seats === null
        ? null
        : cloudAgentSeatsStore.seats.some((seat) => seat.connected),
      githubConnected: github === undefined ? null : github !== null,
      hasProject: workspaceProjectsStore.hasLoaded(workspaceServerId)
        ? workspaceProjectsStore.projectsFor(workspaceServerId).length > 0
        : null,
    }
  }

  /** Asks the stores behind the list for what they do not know yet. */
  refreshGetStarted(): void {
    const workspaceServerId = this.workspaceServerId
    if (workspaceServerId) void workspaceProjectsStore.load(workspaceServerId)
    void this.refreshGithub()
    void cloudAgentSeatsStore.refresh()
  }

  /** The first load takes the read web boot already started; later loads read again. */
  async load(): Promise<void> {
    const account = cloudAccount()
    if (!account) return
    this.account = await (this.accountLoaded ? account.readAccount() : startupAccountRead() ?? account.readAccount())
    this.accountLoaded = true
  }

  /**
   * Reads the account's GitHub connection again: it is made on the account's
   * Connections page in another tab. Only that field changes, and a failed read
   * keeps the last answer rather than closing onboarding.
   */
  async refreshGithub(): Promise<void> {
    const next = await cloudAccount()?.readAccount()
    if (next && this.account) this.account.github = next.github
  }

  /** At a cloud origin, true until the account has answered: the workspace must not paint yet. */
  get isAwaitingAccount(): boolean {
    return this.isCloud && !this.accountLoaded
  }

  /**
   * Holds the default machine until the person picks one. Called again as the
   * directory answers and machines connect, so the default follows what answers.
   */
  chooseDefaultHost(): void {
    if (this.hasChosen) return
    this.chosenServerId = defaultComputeHost(this.choices)?.id ?? null
  }

  choose(serverId: string | null): void {
    this.hasChosen = true
    this.chosenServerId = serverId
  }

  /**
   * Creates the organization's cloud host with the name and spec the person gave
   * (`newCloudHostRequest`); a spec field left out is Solus Cloud's default.
   */
  async createCloudHost(options: { label: string; spec?: ManagedHostSpecRequest }): Promise<void> {
    const organizationId = this.organization?.organizationId
    const account = cloudAccount()
    if (!organizationId || !account || this.hostBusy) return
    this.hostBusy = 'creating'
    this.hostError = null
    try {
      const outcome = await account.createManagedHost(organizationId, options)
      // Read both again whatever the answer: a create that did not answer may still have
      // made the host, and `managed_host_limit` means one exists. Either way the row
      // must show that host, not Create again.
      await serversStore.refreshDirectory()
      await this.load()
      const created = outcome.ok
        ? serversStore.servers.find((server) => server.uplink?.hostId === outcome.hostId)
        : this.choices.cloudHost
      if (created) this.choose(created.id)
      else if (!outcome.ok) this.hostError = createHostFailureMessage(outcome.code, outcome.message)
    } finally {
      this.hostBusy = null
    }
  }

  /**
   * Makes sure agents can run on the chosen machine: a stopped cloud host is started
   * and waited for; any other machine is dialed now and given half a minute to answer.
   * An unreachable machine ends in `hostError`, never in a wait with no end.
   */
  async reachHost(serverId: string): Promise<void> {
    if (this.hostBusy) return
    const host = serversStore.servers.find((server) => server.id === serverId)
    if (!host) return
    const managed = host.uplink?.kind === 'managed'
    const lifecycle = host.uplink?.managedState
    const needsCompute = managed && (managedHostNeedsStart(lifecycle) || awaitsManagedCompute(host.uplink))
    this.hostBusy = managed && managedHostNeedsStart(lifecycle) ? 'starting' : 'connecting'
    this.hostError = null
    try {
      const connected = needsCompute
        ? await serversStore.startManagedHost(serverId, { timeoutMs: 300_000 })
        : await serversStore.connectNow(serverId, { timeoutMs: 30_000 })
      if (connected) return
      this.hostError = managed
        ? 'Solus could not reach the cloud host. Try again, or open its page on Solus Cloud to see why.'
        : `Solus could not reach ${host.label}. Check that Solus is running on it and try again, or choose another machine.`
    } finally {
      this.hostBusy = null
    }
  }

  /**
   * Dials every machine the picker lists now, so each row says whether it answers
   * rather than what an old retry ladder last saw. A cloud host still coming up is
   * left alone: there is nothing to answer yet.
   */
  dialMachines(): void {
    for (const server of this.machines) {
      if (server.status === 'online' || awaitsManagedCompute(server.uplink)) continue
      serverConnections.dialNow(server.id)
    }
  }

  async requestLinkCode(): Promise<void> {
    const source = uplinkAccountSource()
    if (!source) return
    this.linkError = null
    const ticket = await source.issueEnrollmentTicket()
    if (!ticket) {
      this.linkError = 'Solus Cloud did not give a link code. Try again.'
      return
    }
    this.linkCode = ticket
    this.watchForLinkedMachine()
  }

  /** Reads the directory until a new machine of this account appears, then chooses it. */
  private watchForLinkedMachine(): void {
    this.stopWatching()
    const known = new Set(this.choices.ownMachines.map((server) => server.id))
    this.linkPoll = setInterval(() => {
      if (!this.linkCode || Date.now() > this.linkCode.expiresAt) {
        this.stopWatching()
        return
      }
      void serversStore.refreshDirectory().then(() => {
        const linked = this.choices.ownMachines.find((server) => !known.has(server.id))
        if (!linked) return
        this.linkCode = null
        this.stopWatching()
        this.choose(linked.id)
      })
    }, LINK_POLL_MS)
  }

  stopWatching(): void {
    if (this.linkPoll) clearInterval(this.linkPoll)
    this.linkPoll = null
  }

  /** A machine this account linked is visible to the organization only when shared. */
  async setShared(server: ServerItem, shared: boolean): Promise<void> {
    const account = cloudAccount()
    const hostId = server.uplink?.hostId
    const organizationId = this.organization?.organizationId
    if (!account || !hostId || !organizationId) return
    this.sharingServerId = server.id
    try {
      const saved = await account.shareHost(hostId, organizationId, shared)
      if (!saved) this.hostError = 'Solus Cloud did not save the change. Try again.'
      await serversStore.refreshDirectory()
    } finally {
      this.sharingServerId = null
    }
  }

  async loadRepositories(): Promise<void> {
    const serverId = this.workspaceServerId
    if (!serverId) return
    this.repositoriesError = null
    try {
      this.repositories = await serverConnections.apiFor(serverId).providerRepositories('github')
    } catch (error) {
      this.repositoriesError = error instanceof Error ? error.message : String(error)
    }
  }

  /** Adds the repository as a Solus Cloud project, or uses the project that already names it. */
  async chooseRepository(repositoryKey: string): Promise<boolean> {
    const serverId = this.workspaceServerId
    if (!serverId || this.addingRepositoryKey) return false
    this.addingRepositoryKey = repositoryKey
    this.repositoriesError = null
    this.repositoryPreparationError = null
    try {
      const known = workspaceProjectsStore.projectsFor(serverId).some((project) => project.repositoryKey === repositoryKey)
      if (!known) await workspaceProjectsStore.add(serverId, repositoryKey)
      this.chosenRepositoryKey = repositoryKey
      return true
    } catch (error) {
      this.repositoriesError = error instanceof Error ? error.message : String(error)
      return false
    } finally {
      this.addingRepositoryKey = null
    }
  }

  /**
   * Start, with a repository chosen: makes it a project on the machine it will
   * run on — the chosen machine, else the run-on rule's — and only then opens
   * a draft in that checkout, so the composer the person lands in can send at
   * once. A checkout an online machine already holds opens without a clone.
   * False keeps onboarding open: the stage shows why, and Start tries again.
   * With no machine at all, the draft opens unbound and the run picker says why.
   */
  async openChosenRepository(workspace: Pick<WorkspaceContext, 'opening' | 'drafts' | 'router'>): Promise<boolean> {
    const repositoryKey = this.chosenRepositoryKey
    if (!repositoryKey || this.repositoryPreparation) return false
    const preferredServerId = this.chosenServerId ?? undefined
    const choice = workspace.opening.repositoryRunOn(repositoryKey, preferredServerId)
    if (!choice) {
      workspace.opening.openRepositoryDraft(repositoryKey, undefined, preferredServerId)
      return true
    }
    this.repositoryPreparationError = null
    let path = choice.path
    if (!path) {
      this.repositoryPreparation = { serverId: choice.serverId, step: 'reaching' }
      try {
        path = await ensureRepositoryCheckout(choice.serverId, repositoryKey, (step) => {
          if (this.repositoryPreparation) this.repositoryPreparation.step = step
        })
      } catch (error) {
        this.repositoryPreparationError = error instanceof Error ? error.message : String(error)
        return false
      } finally {
        this.repositoryPreparation = null
      }
      // Skipped while it cloned: the person is already working elsewhere.
      if (!this.isOpen) return false
    }
    workspace.drafts.openSessionDraft({ serverId: choice.serverId, target: 'leading' }, path)
    return true
  }

  /**
   * Where the workspace opens when the flow ends without a repository: a new
   * chat on the chosen machine. With no machine, the new-tab home stays.
   */
  landInChat(workspace: Pick<WorkspaceContext, 'drafts' | 'router'>): void {
    const serverId = this.chosenServerId
    if (!serverId) return
    workspace.drafts.openSessionDraft({ serverId, target: 'leading' }, NEW_CHAT_DIRECTORY)
  }

  /** Finishing and skipping both end onboarding for the account, on every
   *  device. A flow reopened from "Get started" only closes: the account
   *  already finished. */
  async complete(): Promise<void> {
    this.stopWatching()
    this.reopenedAt = null
    if (this.account?.onboardingCompletedAt) return
    // Closed at once: a failed write shows the flow again on the next load,
    // which is better than holding the person here.
    if (this.account) this.account.onboardingCompletedAt = Date.now()
    await cloudAccount()?.completeOnboarding()
  }
}

export const cloudOnboardingStore = new CloudOnboardingStore()
