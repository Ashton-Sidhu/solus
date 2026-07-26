import { serverConnections } from '@client-core/server-connections'
import { LOCAL_SERVER_ID, type SavedServer } from '@client-core/server-registry'
import {
  claimServer,
  desktopDeviceLabel,
  pairServer,
  saveBootstrappedServer,
} from '@client-core/pairing'
import { serversStore } from '../../contexts/connections/servers.store.svelte'
import type { SolusAPI } from '../../../preload'
import type {
  DeviceCodePrompt,
  DiscoveredServer,
  HostReadiness,
  IpcContext,
  SetupAgent,
  SetupLogEvent,
  SetupStatusEvent,
  SetupVerification,
} from '../../../shared/types'
import { discoveredServerUrl } from './discovery'
import {
  hostOnboardingSteps,
  providerSetupActions,
  type OnboardingStep,
  type OnboardingStepId,
  type ProviderSetupAction,
} from './lib/host-onboarding'

const LOG_LIMIT = 300

export interface OnboardingHost {
  id: string
  label: string
  /** Carried straight from pairing, so the stage can prove which machine answered. */
  fingerprint?: string
}

/**
 * The stage is one modal with two acts. Pairing is only reached when the host
 * arrives unpaired; a saved host opens straight into `setup`.
 */
export type StagePhase = 'pairing' | 'setup'

/** Where the SSH handshake is. Each one is a different thing to ask the user for. */
export type PairingView = 'connecting' | 'ssh-target' | 'ssh-password' | 'fallback' | 'error'

type ResolveApi = (serverId: string) => SolusAPI

/**
 * Host onboarding: the steps a freshly claimed host needs before it can clone,
 * run a session and push the result back.
 *
 * Always skippable — it is a rail, never a gate. Every step reports from a fresh
 * readiness probe rather than from having been run here, so a host set up by
 * hand, or half-finished last week, resumes exactly where it actually is.
 */
export class HostOnboardingStore {
  isOpen = $state(false)
  host = $state<OnboardingHost | null>(null)

  /** Kept per host so the host directory can show readiness without opening the rail. */
  readinessByHost = $state<Record<string, HostReadiness>>({})
  readinessLoading = $state(false)
  hostName = $state('')

  runningStep = $state<OnboardingStepId | null>(null)
  /** Which provider the running install or sign-in is for. */
  providerInFlight = $state<SetupAgent | null>(null)
  /** Which half of adding that provider is running — the two read very differently. */
  providerStage = $state<ProviderSetupAction | null>(null)
  stepError = $state<{ step: OnboardingStepId; message: string } | null>(null)
  logLines = $state<string[]>([])

  /** The agent CLI's device-flow prompt, while a sign-in waits on the browser. */
  verification = $state<SetupVerification | null>(null)
  /** GitHub's own device-flow prompt, which arrives on a different channel. */
  deviceCode = $state<DeviceCodePrompt | null>(null)

  // ─── Pairing: the first act, only for a host that isn't saved yet ───
  phase = $state<StagePhase>('setup')
  pairingTarget = $state<DiscoveredServer | null>(null)
  pairingView = $state<PairingView>('connecting')
  /** True while a handshake attempt is in flight from one of the forms. */
  pairingBusy = $state(false)
  pairingError = $state('')
  sshTarget = $state('')
  sshPassword = $state('')
  pairCode = $state('')
  private sshPromptAttempt = 0
  /** Bumped per attempt so a superseded handshake can't land on a newer one. */
  private pairingGeneration = 0

  private readonly resolveApi: ResolveApi
  private unsubscribes: Array<() => void> = []
  /**
   * Identifies the rail's current opening. Auto-advance is async, so a user who
   * closes and reopens on another host must not have the previous host's steps
   * land on top of the new one.
   */
  private openToken = 0

  constructor(resolveApi: ResolveApi = (serverId) => serverConnections.apiFor(serverId)) {
    this.resolveApi = resolveApi
  }

  get readiness(): HostReadiness | null {
    return this.host ? this.readinessByHost[this.host.id] ?? null : null
  }

  get steps(): OnboardingStep[] {
    return hostOnboardingSteps({ readiness: this.readiness })
  }

  /** The same step model for a host the rail isn't open on, for the directory row. */
  stepsFor(serverId: string): OnboardingStep[] {
    return hostOnboardingSteps({
      readiness: this.readinessByHost[serverId] ?? null,
    })
  }

  hasProbed(serverId: string): boolean {
    return this.readinessByHost[serverId] !== undefined
  }

  /** Probes a host the rail isn't open on. Readiness is network-free, so a row can afford it. */
  async probeHost(serverId: string): Promise<void> {
    try {
      this.readinessByHost[serverId] = await this.resolveApi(serverId).setupHostReadiness()
    } catch {
      // A host that can't answer isn't a failure worth a message on a list row —
      // its connection status already says so.
    }
  }

  /** The first step still worth doing — where the rail opens, and where "Set up" lands. */
  get nextStep(): OnboardingStep | null {
    return this.steps.find((step) => !step.done && !step.blockedBy) ?? null
  }

  open(host: OnboardingHost): void {
    this.reset()
    const token = this.openToken
    this.host = host
    this.hostName = host.label
    this.phase = 'setup'
    this.isOpen = true
    this.subscribe(host.id)
    void this.refreshReadiness().then(() => this.advanceAutomatically(token))
  }

  /**
   * Opens the same stage on a host that hasn't been paired yet. Pairing and
   * setup are one arrival, so the handshake runs in the stage the user ends up
   * working in rather than in a dialog that hands over to it.
   */
  openForDiscovered(server: DiscoveredServer): void {
    this.reset()
    // A pair started elsewhere leaves justPairedServerId set with nothing to
    // consume it; clear it so a run-on hand-off can't fire on the previous one.
    serversStore.justPairedServerId = null
    this.pairingTarget = server
    this.hostName = server.name
    this.phase = 'pairing'
    this.isOpen = true
    void this.startSshBootstrap()
  }

  close(): void {
    const api = this.api()
    const shouldCancelAgentSignIn =
      this.runningStep === 'providers' && this.providerStage === 'authenticate'
    this.isOpen = false
    void this.cancelGithubConnect()
    if (api && shouldCancelAgentSignIn) {
      void api.setupCancelAgentSignIn().catch(() => {})
    }
    this.reset()
  }

  /** The handshake, from the first automatic attempt through every retry. */
  async startSshBootstrap(
    options: { targetOverride?: string; authSecret?: string; attempt?: number } = {},
  ): Promise<void> {
    const target = this.pairingTarget
    if (!target) return
    const url = discoveredServerUrl(target)
    const generation = ++this.pairingGeneration
    // A retry from a form keeps the form on screen with a busy button; only the
    // first attempt earns the full-panel connecting state.
    if (options.targetOverride !== undefined) {
      this.pairingBusy = true
    } else {
      this.pairingView = 'connecting'
      this.pairingError = ''
    }

    try {
      const result = await this.resolveApi(LOCAL_SERVER_ID).connectionsBootstrapDiscoveredServer({
        server: target,
        ...(options.targetOverride ? { sshTarget: options.targetOverride } : {}),
        ...(options.authSecret ? { authSecret: options.authSecret } : {}),
        ...(options.attempt ? { attempt: options.attempt } : {}),
        deviceLabel: desktopDeviceLabel(),
      })
      if (generation !== this.pairingGeneration || !this.isOpen) return

      if (result.status === 'connected') {
        this.sshPassword = ''
        this.adoptPairedHost(
          saveBootstrappedServer(url, result.credential, target.name),
          target,
          result.credential.fingerprint,
        )
        return
      }

      if (result.status === 'needs-target') {
        this.sshTarget = result.candidates[0]?.target || result.defaultTarget
        this.pairingError = result.message
        this.pairingView = 'ssh-target'
        return
      }

      this.sshTarget = result.sshTarget
      this.sshPromptAttempt = result.attempt
      this.pairingError = result.message
      this.sshPassword = ''
      this.pairingView = 'ssh-password'
    } catch (err) {
      if (generation !== this.pairingGeneration) return
      this.sshPassword = ''
      this.pairingError = messageFor(err)
      this.pairingView = 'error'
    } finally {
      if (generation === this.pairingGeneration) this.pairingBusy = false
    }
  }

  submitSshTarget(): void {
    const trimmed = this.sshTarget.trim()
    if (!trimmed) return
    void this.startSshBootstrap({ targetOverride: trimmed })
  }

  submitSshPassword(): void {
    const secret = this.sshPassword
    if (!secret) return
    this.sshPassword = ''
    void this.startSshBootstrap({
      targetOverride: this.sshTarget,
      authSecret: secret,
      attempt: this.sshPromptAttempt,
    })
  }

  /** For web, mobile, and anywhere SSH isn't on offer. */
  useCodeFallback(): void {
    this.pairingGeneration++
    this.pairingBusy = false
    this.pairCode = ''
    this.sshPassword = ''
    this.pairingView = 'fallback'
  }

  async submitPairCode(): Promise<void> {
    const target = this.pairingTarget
    const trimmed = this.pairCode.trim()
    if (!target || !/^\d{6}$/.test(trimmed)) return
    const url = discoveredServerUrl(target)

    this.pairingBusy = true
    this.pairingError = ''
    try {
      let server: SavedServer
      let fingerprint: string | undefined
      if (target.claimable) {
        const result = await claimServer({
          url,
          code: trimmed,
          deviceLabel: desktopDeviceLabel(),
          serverLabel: target.name,
        })
        server = result.server
        fingerprint = result.fingerprint
      } else {
        const result = await pairServer({
          url,
          pairToken: trimmed,
          deviceLabel: desktopDeviceLabel(),
          serverLabel: target.name,
        })
        server = result.server
      }
      this.adoptPairedHost(server, target, fingerprint)
    } catch (err) {
      this.pairingError = messageFor(err)
    } finally {
      this.pairingBusy = false
    }
  }

  /**
   * The hinge between the two acts: the host is trusted, so the same stage
   * turns into its setup rail without ever closing.
   */
  private adoptPairedHost(
    server: SavedServer,
    target: DiscoveredServer,
    fingerprint?: string,
  ): void {
    serversStore.savePairedServer(server)
    serversStore.toastSnoozedInstallationIds.add(target.installationId)
    // A pair started from the run-on picker already has a destination — that
    // flow retargets the session itself, and this stage's "start working" would
    // move the whole app instead of the one tab the user asked about.
    if (serversStore.pendingRunOnTabId) {
      this.close()
      return
    }
    this.open({ id: server.id, label: server.label || target.name, fingerprint })
  }

  async refreshReadiness(): Promise<void> {
    const host = this.host
    if (!host) return
    this.readinessLoading = true
    try {
      await this.probeHost(host.id)
    } finally {
      this.readinessLoading = false
    }
  }

  async connectGithub(): Promise<void> {
    const token = this.openToken
    await this.run('github', async (api) => {
      try {
        await api.providerConnect(hostProviderContext())
      } finally {
        this.deviceCode = null
      }
    })
    // The credential helper and `gh auth` were only waiting on the token, so
    // there is nothing left to ask about once it lands.
    await this.advanceAutomatically(token)
  }

  async cancelGithubConnect(): Promise<void> {
    const api = this.api()
    if (!api || this.runningStep !== 'github') return
    this.deviceCode = null
    await api.providerCancelConnect(hostProviderContext()).catch(() => {})
  }

  async installCredentialHelper(): Promise<void> {
    await this.run('credential-helper', (api) => api.setupInstallGitCredentialHelper())
  }

  async authorizeGhCli(): Promise<void> {
    await this.run('gh-auth', (api) => api.setupAuthorizeGhCli())
  }

  /**
   * Installs the provider's CLI when the host lacks it and signs it in, as one
   * action. Retrying re-reads readiness, so a failed sign-in retries only the
   * sign-in rather than reinstalling what already landed.
   */
  async addProvider(provider: SetupAgent): Promise<void> {
    this.providerInFlight = provider
    try {
      const state = this.readiness?.agents?.[provider] ?? { installed: false, signedIn: false }
      for (const action of providerSetupActions(state)) {
        this.providerStage = action
        const succeeded =
          action === 'install'
            ? await this.run('providers', (api) => api.setupInstallAgentCli({ agent: provider }))
            : await this.run('providers', async (api) => {
                try {
                  await api.setupAgentSignIn({ agent: provider })
                } finally {
                  this.verification = null
                }
              })
        // Signing in to a CLI that failed to install can only fail again, and a
        // second error would overwrite the one that explains what went wrong.
        if (!succeeded) return
      }
    } finally {
      this.providerStage = null
      this.providerInFlight = null
    }
  }

  /** Runs every automatic step that is unblocked and not yet done, in order. */
  async runAutomaticSteps(): Promise<void> {
    for (const step of this.steps) {
      if (step.done || step.blockedBy || !step.automatic) continue
      if (step.id === 'credential-helper') await this.installCredentialHelper()
      else if (step.id === 'gh-auth') await this.authorizeGhCli()
      // A failed step doesn't stop the rest: they are independent, and stopping
      // would hide what else this host still needs.
    }
  }

  /**
   * Runs the automatic steps only while the rail is still open on the host they
   * were queued for. Deliberately not called from `run()`: that already
   * re-probes readiness in its `finally`, and advancing from there would recurse.
   */
  private async advanceAutomatically(token: number): Promise<void> {
    if (token !== this.openToken || !this.isOpen) return
    await this.runAutomaticSteps()
  }

  /** Reports whether the step landed, so a sequence can stop on the first failure. */
  private async run(step: OnboardingStepId, action: (api: SolusAPI) => Promise<unknown>): Promise<boolean> {
    const api = this.api()
    if (!api || this.runningStep) return false
    this.runningStep = step
    this.stepError = null
    this.logLines = []
    try {
      await action(api)
      return true
    } catch (err) {
      this.stepError = { step, message: messageFor(err) }
      return false
    } finally {
      this.runningStep = null
      // Every step exists to move readiness, so re-probe rather than assume.
      await this.refreshReadiness()
    }
  }

  private api(): SolusAPI | null {
    return this.host ? this.resolveApi(this.host.id) : null
  }

  private subscribe(serverId: string): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe()
    const api = this.resolveApi(serverId)
    this.unsubscribes = [
      api.onSetupLog((event: SetupLogEvent) => {
        this.logLines.push(event.line)
        if (this.logLines.length > LOG_LIMIT) this.logLines.splice(0, this.logLines.length - LOG_LIMIT)
      }),
      api.onSetupStatus((event: SetupStatusEvent) => {
        if (event.verification) {
          const isNewVerification =
            event.verification.url !== this.verification?.url ||
            event.verification.code !== this.verification.code
          this.verification = event.verification
          // Authentication happens in the browser on this machine, not on the
          // host running the CLI. Keep the rendered Open action as a fallback.
          if (isNewVerification) void window.solus.openExternal(event.verification.url)
        }
        if (event.status !== 'running') this.verification = null
      }),
      api.onProviderDeviceCode((prompt: DeviceCodePrompt) => {
        this.deviceCode = prompt
      }),
    ]
  }

  private reset(): void {
    this.openToken += 1
    // Bumped too, so a handshake still in flight can't land on the next opening.
    this.pairingGeneration += 1
    this.phase = 'setup'
    this.pairingTarget = null
    this.pairingView = 'connecting'
    this.pairingBusy = false
    this.pairingError = ''
    this.sshTarget = ''
    this.sshPassword = ''
    this.pairCode = ''
    this.sshPromptAttempt = 0
    for (const unsubscribe of this.unsubscribes) unsubscribe()
    this.unsubscribes = []
    this.host = null
    this.readinessLoading = false
    this.runningStep = null
    this.providerInFlight = null
    this.providerStage = null
    this.stepError = null
    this.logLines = []
    this.verification = null
    this.deviceCode = null
  }
}

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

export const hostOnboardingStore = new HostOnboardingStore()
