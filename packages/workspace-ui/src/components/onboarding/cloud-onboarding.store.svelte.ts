import { cloudAccount, startupAccountRead } from '@solus/client-core/cloud-account'
import { serverConnections } from '@solus/client-core/server-connections'
import { uplinkAccountSource } from '@solus/client-core/uplink-account'
import type { ProviderRepository } from '@solus/contracts/providers'
import type {
  AccountOrganization,
  AccountResponse,
  ManagedHostCatalog,
  ManagedHostSpecRequest,
  UplinkEnrollmentTicket,
} from '@solus/contracts/uplink'
import { connectionsStore, serversStore, workspaceProjectsStore } from '../../contexts'
import {
  computeChoices,
  createHostFailureMessage,
  defaultComputeHost,
  newCloudHostLabel,
  type ComputeChoices,
} from './lib/cloud-compute'
import { managedHostNeedsStart } from '@solus/client-core/server-registry'
import type { ServerItem } from '../../contexts/connections/servers.store.svelte'
import type { WorkspaceContext } from '../../contexts/workspace/workspace.context.svelte'
import type { OnboardingStage } from './lib/onboarding-model'
import type { GetStartedFacts } from './lib/get-started'
import type { IpcContext } from '@solus/contracts/types'
import { hostSetupStore } from '../servers/host-setup.store.svelte'

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
   * Opens the flow again at the stage that sets one "Get started" item. The
   * agents stage needs a machine to ask; with none chosen and none to choose,
   * the flow opens where a machine is chosen instead.
   */
  reopenAt(stage: OnboardingStage): void {
    if (stage === 'agents') this.chooseDefaultHost()
    this.reopenedAt = stage === 'agents' && !this.chosenServerId ? 'compute' : stage
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
    const machines = this.machines
    const readiness = machines.map((server) => hostSetupStore.readinessByHost[server.id]).filter((answer) => !!answer)
    const workspaceServerId = this.workspaceServerId
    const github = connectionsStore.providerStatusFor(workspaceServerId)
    return {
      hasMachine: machines.length > 0,
      hasSignedInAgent: readiness.length === 0
        ? null
        : readiness.some((answer) => Object.values(answer.agents).some((agent) => agent.signedIn)),
      githubConnected: github ? github.connected : null,
      hasProject: workspaceProjectsStore.hasLoaded(workspaceServerId)
        ? workspaceProjectsStore.projectsFor(workspaceServerId).length > 0
        : null,
    }
  }

  /** Asks the stores behind the list for what they do not know yet. */
  refreshGetStarted(ctx: IpcContext): void {
    const workspaceServerId = this.workspaceServerId
    if (workspaceServerId) {
      void connectionsStore.refreshProviderStatus(workspaceServerId, ctx)
      void workspaceProjectsStore.load(workspaceServerId)
    }
    void hostSetupStore.probeUnprobedOnline(this.machines)
  }

  /** The first load takes the read web boot already started; later loads read again. */
  async load(): Promise<void> {
    const account = cloudAccount()
    if (!account) return
    this.account = await (this.accountLoaded ? account.readAccount() : startupAccountRead() ?? account.readAccount())
    this.accountLoaded = true
  }

  /** At a cloud origin, true until the account has answered: the workspace must not paint yet. */
  get isAwaitingAccount(): boolean {
    return this.isCloud && !this.accountLoaded
  }

  /** Picks the default machine once, after the directory has answered. */
  chooseDefaultHost(): void {
    if (this.hasChosen) return
    const host = defaultComputeHost(this.choices)
    if (!host) return
    this.hasChosen = true
    this.chosenServerId = host.id
  }

  choose(serverId: string | null): void {
    this.hasChosen = true
    this.chosenServerId = serverId
  }

  /**
   * Creates the organization's cloud host, named for the organization so the picker
   * reads "Cloud · Acme", with the size picked; none picked is the default.
   */
  async createCloudHost(spec?: ManagedHostSpecRequest): Promise<void> {
    const organizationId = this.organization?.organizationId
    const account = cloudAccount()
    if (!organizationId || !account || this.hostBusy) return
    this.hostBusy = 'creating'
    this.hostError = null
    try {
      const outcome = await account.createManagedHost(organizationId, { label: newCloudHostLabel(this.organization), spec })
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

  /** Starts the cloud host when it is stopped, and waits until this client is connected to it. */
  async startCloudHost(serverId: string): Promise<void> {
    if (this.hostBusy) return
    const lifecycle = serversStore.servers.find((server) => server.id === serverId)?.uplink?.managedState
    this.hostBusy = managedHostNeedsStart(lifecycle) ? 'starting' : 'connecting'
    this.hostError = null
    try {
      const connected = await serversStore.startManagedHost(serverId, { timeoutMs: 300_000 })
      if (!connected) this.hostError = 'Solus could not reach the cloud host. Open its page on Solus Cloud to see why.'
    } finally {
      this.hostBusy = null
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
      const saved = await account.shareHost(hostId, shared ? organizationId : null)
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
   * Where the workspace opens when the flow ends: a new session in the chosen
   * repository, or — without one — in the person's Scratchpad (their chat
   * folder) on the chosen machine. With no machine either, the new-tab home stays.
   */
  async land(workspace: Pick<WorkspaceContext, 'opening' | 'drafts' | 'router'>, withProject: boolean): Promise<void> {
    const repositoryKey = withProject ? this.chosenRepositoryKey : null
    if (repositoryKey) {
      workspace.opening.openRepositoryDraft(repositoryKey, undefined, this.chosenServerId ?? undefined)
      return
    }
    const serverId = this.chosenServerId
    if (!serverId) return
    if (!connectionsStore.capabilitiesFor(serverId)) await connectionsStore.refreshCapabilities({ serverId })
    // The host names the member's own workspace; a managed host's home folder is shared.
    const directory = connectionsStore.capabilitiesFor(serverId)?.workspacePath
    if (!directory) return
    workspace.drafts.openSessionDraft({ serverId, target: workspace.router.leadingPane.id }, directory)
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
