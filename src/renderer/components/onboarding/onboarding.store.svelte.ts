import { serversStore } from '../../contexts'
import { hostSetupStore, type HostSetupSession } from '../servers/host-setup.store.svelte'
import {
  ONBOARDING_STAGES,
  nextStage,
  previousStage,
  type OnboardingMode,
  type OnboardingStage,
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
 * Everything the stages report — agent installs, GitHub and Cloudflare, the
 * keybinding table — is read off the stores that already own it, so onboarding
 * can never disagree with Settings about where the client stands. Completion
 * itself is a client preference and lives in settings, not here.
 */
class OnboardingStore {
  stage = $state<OnboardingStage>('intro')
  mode = $state<OnboardingMode>('project')

  introPhase = $state<IntroPhase>('mark')
  introTyped = $state('')
  /** True for the one fade that carries the greeting off the first stage. */
  introLeaving = $state(false)

  private timers: ReturnType<typeof setTimeout>[] = []
  private greetingTimer: ReturnType<typeof setInterval> | null = null

  get serverId(): string {
    return serversStore.activeServerId
  }

  /** The install-and-sign-in engine for the bound host, shared with Settings. */
  get setup(): HostSetupSession {
    return hostSetupStore.sessionFor(this.serverId)
  }

  start(): void {
    this.stage = 'intro'
    this.mode = 'project'
    this.runIntro()
    void this.setup.refreshReadiness()
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
   * `start()` runs behind the shortcuts stage, so the agents stage usually
   * arrives already answered.
   */
  endIntro(): void {
    if (this.stage !== 'intro' || this.introLeaving) return
    this.introLeaving = true
    this.stage = ONBOARDING_STAGES[0]
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
    const next = nextStage(this.stage)
    if (!next) return false
    this.go(next)
    return true
  }

  back(): void {
    const previous = previousStage(this.stage)
    if (previous) this.go(previous)
  }

  chooseMode(mode: OnboardingMode): void {
    this.mode = mode
  }

  private after(ms: number, run: () => void): void {
    this.timers.push(setTimeout(run, ms))
  }
}

export const onboardingStore = new OnboardingStore()
