import type { AgentHistoryProject } from '@solus/contracts/agent-history'

/**
 * First-run onboarding as one page (docs/plans/one-page-onboarding.md §2): a
 * timeline of steps under one header, with one step open, the done steps
 * folded to a line, and the next steps dimmed. Everything here is pure, so the
 * store and the page read the same rules and tests can check them.
 */

/**
 * Which onboarding this client gets. The connection decides, not the device:
 * - `desktop`: the desktop app, whose shell can hold a Solus Cloud account, so
 *   step 1 asks where the setup lives (decisions 3 and 4).
 * - `host`: a browser paired to one machine. It holds no account, so it gets
 *   the steps of "This Mac only" without step 1.
 * - `cloud`: the web client signed in at a Solus Cloud origin (decision 5).
 */
export type OnboardingFlow = 'desktop' | 'host' | 'cloud'

/** Where the desktop setup lives: the person's Solus Cloud account, or this machine only. */
export type SetupChoice = 'account' | 'local'

export type OnboardingStep =
  /** Desktop step 1: where the setup lives. */
  | 'setup'
  /** Claude Code and Codex: the host's own logins, or the account's seats in the cloud flow. */
  | 'agents'
  /** Folders from the agents' history. */
  | 'projects'
  /** Pair the phone app over the local network. Optional. */
  | 'phone'
  /** Link this machine to the account, and share it. Optional. */
  | 'reach'
  /** Cloud step 1: where the agents run. */
  | 'machine'
  /** Cloud step 3: GitHub and the repository to clone. */
  | 'code'

export function stepsFor(flow: OnboardingFlow, choice: SetupChoice): OnboardingStep[] {
  if (flow === 'cloud') return ['machine', 'agents', 'code']
  if (flow === 'host') return ['agents', 'projects', 'phone']
  return ['setup', 'agents', 'projects', choice === 'account' ? 'reach' : 'phone']
}

/**
 * What is already true before a step opens. An unknown fact is false: a step
 * folds only on a known answer, never on a guess.
 */
export interface AlreadyDoneFacts {
  flow: OnboardingFlow
  /** Desktop: the shell is signed in to a Solus Cloud account. */
  isSignedIn: boolean
  /** Desktop and paired: every agent is signed in on the host. */
  hasEveryHostAgent: boolean
  /** The host's agent history; null until it answers. */
  history: readonly AgentHistoryProject[] | null
  now: number
  /** Desktop: this machine is linked to the account. */
  isLinked: boolean
  /** Cloud: the account has a machine to run agents on. */
  hasMachine: boolean
  /** Cloud: the account has an agent connected. */
  hasAccountAgent: boolean
  /** Cloud: GitHub is connected and the organization has a project. */
  hasCloudProject: boolean
}

/**
 * A step with nothing left to do opens folded as done (decision 10), so a
 * person who set things up on another device, or on this one before, does not
 * do them again. Edit opens it again. The phone step never folds: pairing is
 * this client's own fact, and it is optional.
 */
export function isAlreadyDone(step: OnboardingStep, facts: AlreadyDoneFacts): boolean {
  switch (step) {
    case 'setup':
      return facts.flow === 'desktop' && facts.isSignedIn
    case 'agents':
      return facts.flow === 'cloud' ? facts.hasAccountAgent : facts.hasEveryHostAgent
    case 'projects':
      // WHY: a person with no history still needs the step, to open a first folder.
      return facts.history !== null
        && facts.history.some((project) => project.isProject)
        && defaultCheckedProjects(facts.history, facts.now).length === 0
    case 'reach':
      return facts.isLinked
    case 'machine':
      return facts.hasMachine
    case 'code':
      return facts.hasCloudProject
    case 'phone':
      return false
  }
}

/** A step the person may leave as it is; the footer and the header say so. */
export function isOptional(step: OnboardingStep): boolean {
  return step === 'phone' || step === 'reach'
}

/** What Skip does on a step: on step 1 it keeps everything on this machine (decision 3). */
export function skipEffect(step: OnboardingStep): 'choose-local' | 'next' {
  return step === 'setup' ? 'choose-local' : 'next'
}

/**
 * The step that opens after `done` changed: the first one not done yet. Null
 * means every step is done, and the flow ends (desktop) or shows its ready
 * state (cloud).
 */
export function nextOpenStep(steps: readonly OnboardingStep[], done: ReadonlySet<OnboardingStep>): OnboardingStep | null {
  return steps.find((step) => !done.has(step)) ?? null
}

// ── The timeline ──────────────────────────────────────────────────────────────

/**
 * - `open`: the one step with its body shown.
 * - `done`: folded to one line, with Edit or Change.
 * - `next`: dimmed, its title and one line.
 * - `waiting`: dimmed and blocked: the browser sign-in must end first.
 */
export type StepStatus = 'open' | 'done' | 'next' | 'waiting'

/** The marker in the 22 px column: a number, a check, or a spinner for work that goes on. */
export type StepMarker = 'number' | 'check' | 'spinner'

export interface TimelineEntry {
  step: OnboardingStep
  number: number
  status: StepStatus
  marker: StepMarker
}

export interface TimelineInput {
  steps: readonly OnboardingStep[]
  open: OnboardingStep | null
  done: ReadonlySet<OnboardingStep>
  /** Steps whose work goes on in the background (a cloud host starting, a machine linking). */
  working: ReadonlySet<OnboardingStep>
  /** The desktop browser sign-in is open: step 1 waits on it and blocks the rest. */
  signingIn: boolean
}

export function timeline(input: TimelineInput): TimelineEntry[] {
  const { steps, open, done, working, signingIn } = input
  return steps.map((step, index) => {
    const number = index + 1
    if (signingIn && step === 'setup') return { step, number, status: 'open', marker: 'spinner' }
    if (signingIn) return { step, number, status: 'waiting', marker: 'number' }
    if (step === open) return { step, number, status: 'open', marker: 'number' }
    if (done.has(step)) return { step, number, status: 'done', marker: working.has(step) ? 'spinner' : 'check' }
    return { step, number, status: 'next', marker: working.has(step) ? 'spinner' : 'number' }
  })
}

/** The end of the header line: where the person is, in their words. */
export function progressLine(steps: readonly OnboardingStep[], open: OnboardingStep | null): string {
  if (!open) return 'is ready.'
  const index = steps.indexOf(open)
  if (index === steps.length - 1 && isOptional(open)) return 'Last step, and it’s optional.'
  return `Step ${index + 1} of ${steps.length}.`
}

// ── The footer ────────────────────────────────────────────────────────────────

/** What the page knows that changes the footer's words. */
export interface FooterFacts {
  choice: SetupChoice
  signingIn: boolean
  signedIn: boolean
  /** Agents ready on the host, or connected in the account. */
  readyAgents: number
  /** An agent sign-in is waiting on the browser; its name, for "<name> can finish later." */
  pendingAgent: string | null
  checkedProjects: number
  /** The first checked project, which the workspace opens in. */
  landingProject: string | null
  /** Cloud step 1. */
  machineTarget: 'cloud' | 'own'
  /** The organization offers the chosen target (its host rules, and who may create a cloud host). */
  machineOffered: boolean
  hasCloudHost: boolean
  hasLinkCommand: boolean
  githubConnected: boolean
  /** The repository chosen in the code step, by its short name. */
  repositoryName: string | null
  /** A step is doing its primary action now. */
  isBusy: boolean
}

export interface Footer {
  hint: string
  primaryLabel: string
  primaryEnabled: boolean
  /** The quiet action beside the primary: Skip, or on the cloud ready state, Invite your team. */
  secondary: 'skip' | 'invite'
}

function startLabel(project: string | null): string {
  return project ? `Start in ${project}` : 'Start'
}

function setupFooter(facts: FooterFacts, ready: boolean): Footer {
  if (facts.signingIn) return { hint: 'Waiting for your browser…', primaryLabel: 'Continue', primaryEnabled: false, secondary: 'skip' }
  if (facts.choice === 'account' && !facts.signedIn) {
    return { hint: 'Skip keeps everything on this Mac.', primaryLabel: 'Sign in to Solus Cloud', primaryEnabled: ready, secondary: 'skip' }
  }
  return { hint: 'You can change this in Settings.', primaryLabel: 'Continue', primaryEnabled: ready, secondary: 'skip' }
}

function machineFooter(facts: FooterFacts, ready: boolean): Footer {
  if (!facts.machineOffered) return { hint: 'An owner of your organization chooses where agents run.', primaryLabel: 'Continue', primaryEnabled: false, secondary: 'skip' }
  if (facts.machineTarget === 'own') {
    return { hint: 'It links while you finish.', primaryLabel: facts.hasLinkCommand ? 'Continue' : 'Get the command', primaryEnabled: ready, secondary: 'skip' }
  }
  return { hint: 'It starts while you finish.', primaryLabel: facts.hasCloudHost ? 'Continue' : 'Create cloud host', primaryEnabled: ready, secondary: 'skip' }
}

function codeFooter(facts: FooterFacts, ready: boolean): Footer {
  const hint = 'Or start with an empty project.'
  if (!facts.githubConnected) return { hint, primaryLabel: 'Connect GitHub', primaryEnabled: ready, secondary: 'skip' }
  return { hint, primaryLabel: 'Clone and start', primaryEnabled: ready && !!facts.repositoryName, secondary: 'skip' }
}

/** The footer of the open step; null is the cloud flow's ready state. */
export function footerFor(step: OnboardingStep | null, facts: FooterFacts): Footer {
  const ready = !facts.isBusy
  switch (step) {
    case null:
      return { hint: 'Your agents are waiting.', primaryLabel: startLabel(facts.repositoryName), primaryEnabled: ready, secondary: 'invite' }
    case 'setup':
      return setupFooter(facts, ready)
    case 'agents':
      return {
        hint: facts.pendingAgent ? `${facts.pendingAgent} can finish later.` : 'One agent is enough.',
        primaryLabel: 'Continue',
        primaryEnabled: ready && facts.readyAgents > 0,
        secondary: 'skip',
      }
    case 'projects':
      return {
        hint: 'You can add projects any time.',
        primaryLabel: facts.checkedProjects > 0
          ? `Continue with ${facts.checkedProjects} ${facts.checkedProjects === 1 ? 'project' : 'projects'}`
          : 'Continue',
        primaryEnabled: ready,
        secondary: 'skip',
      }
    case 'phone':
      return { hint: 'Sign in later to use it anywhere.', primaryLabel: startLabel(facts.landingProject), primaryEnabled: ready, secondary: 'skip' }
    case 'reach':
      return { hint: 'Link any time in Settings.', primaryLabel: startLabel(facts.landingProject), primaryEnabled: ready, secondary: 'skip' }
    case 'machine':
      return machineFooter(facts, ready)
    case 'code':
      return codeFooter(facts, ready)
  }
}

// ── Reach it from anywhere ────────────────────────────────────────────────────

export interface ReachRows {
  link: { checked: boolean; disabled: boolean }
  share: { disabled: boolean; detail: string }
}

/**
 * Link this Mac is off unless the host says it is linked: onboarding never
 * links on its own (decision 4). Sharing with the organization needs the link,
 * so it is disabled until the link is on.
 */
export function reachRows(input: { linked: boolean | undefined; busy: boolean; signedIn: boolean }): ReachRows {
  const linked = input.linked === true
  return {
    link: { checked: linked, disabled: input.busy || !input.signedIn },
    share: {
      disabled: !linked || input.busy,
      detail: linked ? 'Members of the organization can run agents on it' : 'Link this Mac first.',
    },
  }
}

// ── Projects from agent history ───────────────────────────────────────────────

/** How long ago a folder may have been used and still be checked by default. */
export const RECENT_PROJECT_MS = 14 * 24 * 60 * 60 * 1000
/** At most this many folders are checked by default. */
export const DEFAULT_CHECKED_PROJECTS = 5
/** Rows shown before "Show n more". */
export const VISIBLE_PROJECT_ROWS = 4

/** The folders worth offering: still on disk, newest first. */
export function historyRows(projects: readonly AgentHistoryProject[]): AgentHistoryProject[] {
  return projects.filter((project) => project.exists).sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

/** The recent folders are checked (decision 6); a folder that is a project already needs nothing. */
export function defaultCheckedProjects(projects: readonly AgentHistoryProject[], now: number): string[] {
  return historyRows(projects)
    .filter((project) => !project.isProject && now - project.lastUsedAt <= RECENT_PROJECT_MS)
    .slice(0, DEFAULT_CHECKED_PROJECTS)
    .map((project) => project.path)
}

/** "today", "3d", "2w", "4mo": short enough for the row's trailing lane. */
export function ageLabel(lastUsedAt: number, now: number): string {
  const days = Math.floor(Math.max(0, now - lastUsedAt) / 86_400_000)
  if (days < 1) return 'today'
  if (days < 7) return `${days}d`
  if (days < 60) return `${Math.floor(days / 7)}w`
  return `${Math.floor(days / 30)}mo`
}
