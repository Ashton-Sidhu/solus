import { cloudAccount } from '@solus/client-core/cloud-account'
import { serverConnections } from '@solus/client-core/server-connections'
import { accountStore, runtime, serversStore } from '../../contexts'
import { hostSetupStore, type HostSetupSession } from '../servers/host-setup.store.svelte'
import { cloudOnboardingStore } from './cloud-onboarding.store.svelte'
import {
  nextStage,
  previousStage,
  stagesFor,
  surfaceFor,
  type OnboardingFlow,
  type OnboardingMode,
  type OnboardingStage,
  type OnboardingSurface,
  type StageConditions,
} from './lib/onboarding-model'

/** The greeting is the mark arriving, then a line that types itself. */
export type IntroPhase = 'mark' | 'greeting'

const GREETING = 'Welcome to Solus'
/** Per-character typing interval. Slow enough to read, quick enough to skip past. */
const GREETING_TICK_MS = 64
const MARK_MS = 2650
const GREETING_HOLD_MS = 1200
const LEAVE_MS = 560

/**
 * The one place first-run onboarding keeps its own state: which stage is open,
 * how the greeting is doing, and what the last stage decided.
 *
 * Everything the stages report — agent installs, GitHub and Cloudflare — is
 * read off the stores that already own it, so onboarding
 * can never disagree with Settings about where the client stands. Completion
 * itself is a client preference and lives in settings, not here.
 */
class OnboardingStore {
  stage = $state<OnboardingStage>('intro')
  mode = $state<OnboardingMode>('project')
  /**
   * Fixed for the run rather than derived. A phone that gains a keyboard, or a
   * browser window dragged onto a touch screen, would otherwise swap the stage
   * list out from under the stage the user is standing on.
   */
  surface = $state<OnboardingSurface>('pointer')
  /** Fixed for the run, like `surface`: a cloud account or one host. */
  flow = $state<OnboardingFlow>('host')

  introPhase = $state<IntroPhase>('mark')
  introTyped = $state('')
  /** True for the one fade that carries the greeting off the first stage. */
  introLeaving = $state(false)

  /** The stage that opened `name-project`, which its Back returns to. */
  private nameProjectFrom: OnboardingStage = 'start'

  private timers: ReturnType<typeof setTimeout>[] = []
  private greetingTimer: ReturnType<typeof setInterval> | null = null

  /**
   * The one host every stage asks about. The host flow asks the host this
   * client works against; the cloud flow asks the machine the person chose,
   * never the workspace service, which runs no agents. Empty when the cloud
   * flow has no machine, and then the `agents` stage is not shown.
   */
  get serverId(): string {
    if (this.flow === 'cloud') return cloudOnboardingStore.chosenServerId ?? ''
    return serverConnections.defaultMachineId() ?? serversStore.activeServerId
  }

  /** The install-and-sign-in engine for the bound host, shared with Settings. */
  get setup(): HostSetupSession {
    return hostSetupStore.sessionFor(this.serverId)
  }

  /**
   * The cloud flow passes over `agents` when there is no machine to ask, and
   * `cloud-connect` shows only where the shell holds an account (desktop).
   */
  private get conditions(): StageConditions {
    return {
      skipsAgents: this.flow === 'cloud' && !cloudOnboardingStore.chosenServerId,
      offersCloudConnect: accountStore.isAvailable,
    }
  }

  start(): void {
    this.stage = 'intro'
    this.mode = 'project'
    this.surface = surfaceFor(runtime)
    this.flow = cloudAccount() ? 'cloud' : 'host'
    // Reopened from a "Get started" item: straight to the stage it names, no greeting.
    const reopenedAt = this.flow === 'cloud' ? cloudOnboardingStore.reopenedAt : null
    if (reopenedAt) {
      this.stage = reopenedAt
      return
    }
    this.runIntro()
    // The cloud flow has no machine yet; `agents` probes the one chosen.
    if (this.flow === 'host') void this.setup.refreshReadiness()
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
    if (this.greetingTimer) clearInterval(this.greetingTimer)
    this.greetingTimer = null
  }

  // ── The greeting ────────────────────────────────────────────────────────────

  private runIntro(): void {
    this.introPhase = 'mark'
    this.introTyped = ''
    this.introLeaving = false
    this.after(MARK_MS, () => {
      if (this.stage !== 'intro') return
      this.introPhase = 'greeting'
      let typed = 0
      this.greetingTimer = setInterval(() => {
        typed++
        this.introTyped = GREETING.slice(0, typed)
        if (typed < GREETING.length) return
        if (this.greetingTimer) clearInterval(this.greetingTimer)
        this.greetingTimer = null
        this.after(GREETING_HOLD_MS, () => this.endIntro())
      }, GREETING_TICK_MS)
    })
  }

  /**
   * Leaves the greeting. The first stage is put up first and the greeting fades
   * over it, so the stage is already laid out behind the fade rather than
   * appearing empty once it clears. The host readiness probe kicked off in
   * `start()` runs behind the greeting, so the agents stage usually arrives
   * already answered.
   */
  endIntro(): void {
    if (this.stage !== 'intro' || this.introLeaving) return
    this.introLeaving = true
    this.stage = stagesFor(this.surface, this.flow)[0]
    this.after(LEAVE_MS, () => {
      this.introLeaving = false
    })
  }

  // ── Moving between stages ───────────────────────────────────────────────────

  go(stage: OnboardingStage): void {
    if (stage === this.stage) return
    this.stop()
    this.stage = stage
  }

  /** Moves on, or reports that the flow is over so the caller can finish it. */
  advance(): boolean {
    const next = nextStage(this.stage, this.surface, this.flow, this.conditions)
    if (!next) return false
    this.go(next)
    return true
  }

  back(): void {
    if (this.stage === 'name-project') {
      this.go(this.nameProjectFrom)
      return
    }
    if (this.stage === 'open-project') {
      this.go('start')
      return
    }
    const previous = previousStage(this.stage, this.surface, this.flow, this.conditions)
    if (previous) this.go(previous)
  }

  /** Starting from nothing is one more question — the name — not the end of the flow. */
  nameNewProject(): void {
    if (this.stage === 'name-project') return
    this.nameProjectFrom = this.stage
    this.go('name-project')
  }

  /** Existing code is one more question too — which folder — asked inside the flow. */
  openExistingCode(): void {
    this.go('open-project')
  }

  chooseMode(mode: OnboardingMode): void {
    this.mode = mode
  }

  private after(ms: number, run: () => void): void {
    this.timers.push(setTimeout(run, ms))
  }
}

export const onboardingStore = new OnboardingStore()
