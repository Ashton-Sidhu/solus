import { serverConnections } from '@client-core/server-connections'
import { localApi } from '@client-core/local-api'
import type { SolusAPI } from '../../../preload'
import type {
  DeviceCodePrompt,
  GitCommitIdentity,
  HostReadiness,
  SetupAgent,
  SetupLogEvent,
  SetupStatusEvent,
  SetupVerification,
} from '../../../shared/types'
import type { ServerItem } from '../../contexts'
import {
  hostOnboardingSteps,
  providerSetupActions,
  type OnboardingStep,
  type OnboardingStepId,
  type ProviderSetupAction,
} from './lib/host-onboarding'
import { hostProviderContext, messageFor } from './lib/setup-rpc'

const LOG_LIMIT = 300

type ResolveApi = (serverId: string) => SolusAPI

/**
 * What a run can be busy with. The rail's four steps plus the two repairs that
 * only the host page offers, so one `runningStep` covers both surfaces.
 */
export type SetupActionId = OnboardingStepId | 'git' | 'identity'

/**
 * Everything that can be run *on a host* to make it able to clone, take a
 * session and push the work back — plus what is running right now and which
 * browser prompt it is waiting on.
 *
 * Owned by the host rather than by whatever is drawing it, because two surfaces
 * ask for the same things: the onboarding rail on arrival, and the host page in
 * settings afterwards. One engine means they can never disagree about where a
 * host stands, and closing one of them doesn't abandon an install.
 */
export class HostSetupSession {
  readinessLoading = $state(false)
  readinessError = $state<string | null>(null)
  runningStep = $state<SetupActionId | null>(null)
  /** Provider setup is independent: one can install while the other signs in. */
  providerStages = $state<Record<SetupAgent, ProviderSetupAction | null>>({
    claude: null,
    codex: null,
  })
  stepError = $state<{ step: SetupActionId; message: string; provider?: SetupAgent } | null>(null)
  /** When readiness was last read off the host, so "Test" can say how fresh its answer is. */
  lastCheckedAt = $state<number | null>(null)
  logLines = $state<string[]>([])

  /** The agent CLI's browser prompt, while a sign-in waits on the user. */
  verifications = $state<Record<SetupAgent, SetupVerification | null>>({
    claude: null,
    codex: null,
  })
  /** GitHub's own device-flow prompt, which arrives on a different channel. */
  deviceCode = $state<DeviceCodePrompt | null>(null)

  private holders = 0
  private unsubscribes: Array<() => void> = []
  /** Sign-ins the user called off, so the kill they asked for isn't reported back as a failure. */
  private readonly abandonedSignIns = new Set<SetupAgent>()

  constructor(
    readonly serverId: string,
    private readonly store: HostSetupStore,
  ) {}

  get readiness(): HostReadiness | null {
    return this.store.readinessByHost[this.serverId] ?? null
  }

  get steps(): OnboardingStep[] {
    return hostOnboardingSteps({ readiness: this.readiness })
  }

  /**
   * `installGh` was added with the matching RPC method. Older hosts omit both,
   * so the readiness field is also the capability signal across that version
   * boundary.
   */
  get canInstallGh(): boolean {
    return this.readiness?.installGh?.autoRunnable === true
  }

  /**
   * Setup events arrive on the host's own channel, so both surfaces can watch
   * one run. The subscription lasts as long as one of them still wants it.
   */
  retain(): void {
    if (this.holders++ > 0) return
    const events = serverConnections.eventsFor(this.serverId)
    this.unsubscribes = [
      events.subscribe('setup.logAppended', (event: SetupLogEvent) => {
        this.logLines.push(event.line)
        if (this.logLines.length > LOG_LIMIT) this.logLines.splice(0, this.logLines.length - LOG_LIMIT)
      }),
      events.subscribe('setup.statusChanged', (event: SetupStatusEvent) => {
        if (event.verification) {
          const provider = providerForSetupStep(event.step)
          if (!provider) return
          const isNewVerification =
            event.verification.url !== this.verifications[provider]?.url ||
            event.verification.code !== this.verifications[provider]?.code ||
            event.verification.requiresCodeInput !== this.verifications[provider]?.requiresCodeInput
          this.verifications[provider] = event.verification
          // Authentication happens in the browser on this machine, not on the
          // host running the CLI. Keep the rendered Open action as a fallback.
          if (isNewVerification) void localApi.openExternal(event.verification.url)
        }
        if (event.status !== 'running') {
          const provider = providerForSetupStep(event.step)
          if (provider) this.verifications[provider] = null
        }
      }),
      events.subscribe('provider.deviceCodeReceived', (prompt: DeviceCodePrompt) => {
        this.deviceCode = prompt
      }),
    ]
  }

  release(): void {
    this.holders = Math.max(0, this.holders - 1)
    if (this.holders > 0) return
    for (const unsubscribe of this.unsubscribes) unsubscribe()
    this.unsubscribes = []
  }

  async refreshReadiness(): Promise<void> {
    this.readinessLoading = true
    this.readinessError = null
    try {
      await this.store.refreshHost(this.serverId)
    } catch (err) {
      this.readinessError = messageFor(err)
    } finally {
      this.readinessLoading = false
      this.lastCheckedAt = Date.now()
    }
  }

  async connectGithub(): Promise<void> {
    await this.run('github', async (api) => {
      try {
        await api.providerConnect(hostProviderContext())
      } finally {
        this.deviceCode = null
      }
    })
    // The credential helper and `gh auth` were only waiting on the token, so
    // there is nothing left to ask about once it lands.
    await this.runAutomaticSteps()
  }

  async cancelGithubConnect(): Promise<void> {
    if (this.runningStep !== 'github') return
    this.deviceCode = null
    await this.store
      .resolveApi(this.serverId)
      .providerCancelConnect(hostProviderContext())
      .catch(() => {})
  }

  async installCredentialHelper(): Promise<void> {
    await this.run('credential-helper', (api) => api.setupInstallGitCredentialHelper())
  }

  async installGh(): Promise<void> {
    if (!this.canInstallGh) {
      const command = this.readiness?.installGh?.display
      this.stepError = {
        step: 'gh-cli',
        message: command
          ? `Run this on the host, then re-scan: ${command}`
          : 'Update Solus on this host, or install the GitHub CLI manually, then re-scan.',
      }
      return
    }
    await this.run('gh-cli', (api) => api.setupInstallGh())
  }

  async authorizeGhCli(): Promise<void> {
    await this.run('gh-auth', (api) => api.setupAuthorizeGhCli())
  }

  /**
   * Installs the provider's CLI when the host lacks it and signs it in, as one
   * action. Retrying re-reads readiness, so a failed sign-in retries only the
   * sign-in rather than reinstalling what already landed.
   *
   * `force` re-runs the sign-in on a provider that already reads as signed in,
   * for a token that has gone stale since the host last answered.
   */
  async addProvider(provider: SetupAgent, opts?: { force?: boolean }): Promise<void> {
    if (this.providerStages[provider]) return
    try {
      const state = this.readiness?.agents?.[provider] ?? { installed: false, signedIn: false }
      for (const action of providerSetupActions(state, opts)) {
        this.providerStages[provider] = action
        const succeeded =
          action === 'install'
            ? await this.run('providers', (api) => api.setupInstallAgentCli({ agent: provider }), provider)
            : await this.run('providers', async (api) => {
                try {
                  await api.setupAgentSignIn({ agent: provider })
                } finally {
                  this.verifications[provider] = null
                }
              }, provider)
        // Signing in to a CLI that failed to install can only fail again, and a
        // second error would overwrite the one that explains what went wrong.
        if (!succeeded) return
      }
    } finally {
      this.providerStages[provider] = null
    }
  }

  async submitAgentSignInCode(provider: SetupAgent, code: string): Promise<void> {
    this.stepError = null
    try {
      await this.store.resolveApi(this.serverId).setupSubmitAgentSignInCode({ agent: provider, code })
    } catch (err) {
      this.stepError = { step: 'providers', message: messageFor(err), provider }
      throw err
    }
  }

  /**
   * Abandons a sign-in the user has stopped waiting on. Without this the CLI
   * sits on the host until a later attempt supersedes it, and the row spins with
   * nothing to press.
   */
  async cancelAgentSignIn(provider: SetupAgent): Promise<void> {
    this.abandonedSignIns.add(provider)
    this.verifications[provider] = null
    await this.store.resolveApi(this.serverId).setupCancelAgentSignIn().catch(() => {})
  }

  /**
   * The only step-id dispatcher, shared by the rail's retry and automatic run.
   * `providers` isn't here: which provider to add is a choice, so the card that
   * offers it calls `addProvider` with the one the user pressed.
   */
  async runStep(id: OnboardingStepId): Promise<void> {
    switch (id) {
      case 'github':
        await this.connectGithub()
        return
      case 'credential-helper':
        await this.installCredentialHelper()
        return
      case 'gh-cli':
        await this.installGh()
        return
      case 'gh-auth':
        await this.authorizeGhCli()
    }
  }

  /** Runs every automatic step that is unblocked and not yet done, in order. */
  async runAutomaticSteps(): Promise<void> {
    // The order is fixed, but each step is re-read as its turn comes: every run
    // re-probes readiness, so `gh auth` unblocks once `gh` itself lands rather
    // than being skipped for the state it was in when the sequence started.
    const order = this.steps.map((step) => step.id)
    for (const id of order) {
      const step = this.steps.find((candidate) => candidate.id === id)!
      if (step.done || step.blockedBy || !step.automatic) continue
      if (step.id === 'gh-cli' && !this.canInstallGh) continue
      await this.runStep(step.id)
      // A failed step doesn't stop the rest: they are independent, and stopping
      // would hide what else this host still needs.
    }
  }

  /**
   * The two repairs that are not rail steps: a host without git can't clone,
   * and a host without a commit identity can't attribute what it pushes. Both
   * are offered where the user is looking at the gap rather than on arrival.
   */
  async installGit(): Promise<void> {
    await this.run('git', (api) => api.setupInstallGit())
  }

  async setGitIdentity(identity: GitCommitIdentity): Promise<void> {
    await this.run('identity', (api) => api.setupSetGitIdentity(identity))
  }

  /** Reports whether the step landed, so a sequence can stop on the first failure. */
  private async run(
    step: SetupActionId,
    action: (api: SolusAPI) => Promise<unknown>,
    provider?: SetupAgent,
  ): Promise<boolean> {
    if (!provider && this.runningStep) return false
    if (!provider) this.runningStep = step
    this.stepError = null
    this.logLines = []
    try {
      await action(this.store.resolveApi(this.serverId))
      return true
    } catch (err) {
      // A sign-in the user called off comes back as a killed process. That is
      // the cancel working, not a failure to report at them.
      if (provider && this.abandonedSignIns.delete(provider)) return false
      this.stepError = { step, message: messageFor(err), ...(provider ? { provider } : {}) }
      return false
    } finally {
      if (!provider) this.runningStep = null
      // Every step exists to move readiness, so re-probe rather than assume.
      await this.refreshReadiness()
    }
  }
}

class HostSetupStore {
  /**
   * Shared, so a directory row, the rail and the host page all read one answer
   * about a host instead of each holding a copy that drifts.
   */
  readinessByHost = $state<Record<string, HostReadiness>>({})

  /** Not a `SvelteMap`: identity is stable, and `sessionFor` is called from `$derived`. */
  private readonly sessions = new Map<string, HostSetupSession>()

  constructor(readonly resolveApi: ResolveApi = (serverId) => serverConnections.apiFor(serverId)) {}

  sessionFor(serverId: string): HostSetupSession {
    let session = this.sessions.get(serverId)
    if (!session) {
      session = new HostSetupSession(serverId, this)
      this.sessions.set(serverId, session)
    }
    return session
  }

  /** The step model for a host no surface is open on, for a directory row. */
  stepsFor(serverId: string): OnboardingStep[] {
    return hostOnboardingSteps({ readiness: this.readinessByHost[serverId] ?? null })
  }

  hasProbed(serverId: string): boolean {
    return this.readinessByHost[serverId] !== undefined
  }

  /** Probes only reachable rows that have no shared readiness answer yet. */
  async probeUnprobedOnline(servers: ServerItem[]): Promise<void> {
    await Promise.all(
      servers
        .filter((server) => server.status === 'online' && !this.hasProbed(server.id))
        .map((server) => this.probeHost(server.id)),
    )
  }

  /** Refreshes the shared cache and lets an open surface report the failure. */
  async refreshHost(serverId: string): Promise<void> {
    this.readinessByHost[serverId] = await this.resolveApi(serverId).setupHostReadiness()
  }

  /** Readiness is network-free on the host, so a list row can afford to ask. */
  async probeHost(serverId: string): Promise<void> {
    try {
      await this.refreshHost(serverId)
    } catch {
      // A host that can't answer isn't a failure worth a message on a list row —
      // its connection status already says so.
    }
  }
}

function providerForSetupStep(step: SetupStatusEvent['step']): SetupAgent | null {
  if (step === 'install-claude' || step === 'signin-claude') return 'claude'
  if (step === 'install-codex' || step === 'signin-codex') return 'codex'
  return null
}

export const hostSetupStore = new HostSetupStore()
