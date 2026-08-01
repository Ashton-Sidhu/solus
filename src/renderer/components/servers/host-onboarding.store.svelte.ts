import { serverConnections } from '@client-core/server-connections'
import { LOCAL_SERVER_ID, type SavedServer } from '@client-core/server-registry'
import {
  claimServer,
  defaultDeviceLabel,
  pairServer,
  saveBootstrappedServer,
} from '@client-core/pairing'
import { discoveredServerUrl, serversStore } from '../../contexts'
import type { SolusAPI } from '../../../preload'
import type { DiscoveredServer } from '../../../shared/types'
import { hostSetupStore, type HostSetupSession } from './host-setup.store.svelte'
import { messageFor } from './lib/setup-rpc'

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
 * Host onboarding: the stage a host arrives through — the SSH handshake, and
 * then the rail that walks its setup one decision at a time.
 *
 * The setup work itself belongs to `hostSetupStore`, which the host page in
 * settings drives too. This store owns only the modal: which host it is open
 * on, which act it is in, and the pairing handshake.
 */
export class HostOnboardingStore {
  isOpen = $state(false)
  host = $state<OnboardingHost | null>(null)
  hostName = $state('')

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
  /** The session the rail is holding open, so `reset` releases the right one. */
  private retained: HostSetupSession | null = null

  constructor(resolveApi: ResolveApi = (serverId) => serverConnections.apiFor(serverId)) {
    this.resolveApi = resolveApi
  }

  /** The rail's whole setup act. Read through this — nothing is forwarded. */
  get setup(): HostSetupSession | null {
    return this.host ? hostSetupStore.sessionFor(this.host.id) : null
  }

  open(host: OnboardingHost): void {
    const isSameHost = this.phase === 'setup' && this.host?.id === host.id
    if (!isSameHost) {
      this.reset()
      const setup = hostSetupStore.sessionFor(host.id)
      this.retained = setup
      setup.retain()
    }
    this.host = host
    this.hostName = host.label
    this.phase = 'setup'
    this.isOpen = true
    const setup = hostSetupStore.sessionFor(host.id)
    void setup.refreshReadiness().then(() => {
      if (!isSameHost) void setup.runAutomaticSteps()
    })
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
    this.isOpen = false
    // Setup work belongs to the host, not the modal. Keep its subscriptions and
    // promises alive so reopening shows the current install/auth state.
    if (this.phase === 'pairing') {
      this.reset()
    }
  }

  /** The handshake, from the first automatic attempt through every retry. */
  async startSshBootstrap(
    options: { targetOverride?: string; authSecret?: string; attempt?: number } = {},
  ): Promise<void> {
    const target = this.pairingTarget
    if (!target) return
    // SSH bootstrap shells out from wherever "local" resolves: the desktop app
    // itself, or — on web — the connected server, which reaches the discovered
    // host with the user's own SSH access. Only a client with no host at all
    // falls back to pairing by code.
    let sshApi: SolusAPI
    try {
      sshApi = this.resolveApi(LOCAL_SERVER_ID)
    } catch {
      this.useCodeFallback()
      return
    }
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
      const result = await sshApi.connectionsBootstrapDiscoveredServer({
        server: target,
        ...(options.targetOverride ? { sshTarget: options.targetOverride } : {}),
        ...(options.authSecret ? { authSecret: options.authSecret } : {}),
        ...(options.attempt ? { attempt: options.attempt } : {}),
        deviceLabel: defaultDeviceLabel(),
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

  /** Enter and the stage footer submit the visible pairing form identically. */
  submitCurrentPairingView(): void {
    if (this.pairingView === 'ssh-target') this.submitSshTarget()
    else if (this.pairingView === 'ssh-password') this.submitSshPassword()
    else if (this.pairingView === 'fallback') void this.submitPairCode()
    else if (this.pairingView === 'error') void this.startSshBootstrap()
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
          deviceLabel: defaultDeviceLabel(),
          serverLabel: target.name,
        })
        server = result.server
        fingerprint = result.fingerprint
      } else {
        const result = await pairServer({
          url,
          pairToken: trimmed,
          deviceLabel: defaultDeviceLabel(),
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

  private reset(): void {
    // Bumped so a handshake still in flight can't land on the next opening.
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
    this.retained?.release()
    this.retained = null
    this.host = null
  }
}

export const hostOnboardingStore = new HostOnboardingStore()
