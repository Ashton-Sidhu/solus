import type { HostReadiness } from '@solus/contracts/types'
import type { Footer, StepMarker, StepStatus } from '../../onboarding/lib/onboarding-model'
import { hostOnboardingSteps, type OnboardingStepId, type PairingView } from './host-onboarding'

/**
 * The setup of a new host as one timeline, drawn like first-run onboarding
 * (docs/plans/one-page-onboarding.md) without its projects: pair the host,
 * connect its agents, then GitHub. Everything here is pure, so the modal and
 * the tests read the same rules.
 */
export type HostStageStep = 'pair' | 'agents' | 'github'

export const HOST_STAGE_STEPS: readonly HostStageStep[] = ['pair', 'agents', 'github']

export interface HostStageEntry {
  step: HostStageStep
  number: number
  status: StepStatus
  marker: StepMarker
}

export interface HostStageInput {
  /** The host is not paired yet: the pair step is open and the others wait. */
  isPairing: boolean
  pairingView: PairingView
  pairingBusy: boolean
  readiness: HostReadiness | null
  /** The setup step that runs now, and the one whose last run failed. */
  runningStep: string | null
  failedStep: string | null
  /** Steps the person left for later (Skip). */
  skipped: ReadonlySet<HostStageStep>
  /** A done step the person opened again (Edit). */
  reopened: HostStageStep | null
}

export interface HostStage {
  entries: HostStageEntry[]
  /** The one open step; null when each step is done or skipped. */
  open: HostStageStep | null
  /** Each agent and GitHub that the host has, by readiness. */
  done: ReadonlySet<HostStageStep>
}

/** What runs after GitHub connects, with nothing to decide: it shows on the GitHub line. */
const GITHUB_FOLLOW_THROUGH: readonly OnboardingStepId[] = ['credential-helper', 'gh-cli', 'gh-auth']

export function hostStage(input: HostStageInput): HostStage {
  const steps = hostOnboardingSteps({ readiness: input.readiness })
  const isDone = (id: OnboardingStepId) => steps.find((step) => step.id === id)?.done ?? false
  const done = new Set<HostStageStep>()
  if (!input.isPairing) done.add('pair')
  if (isDone('providers')) done.add('agents')
  if (isDone('github')) done.add('github')
  const open: HostStageStep | null = input.isPairing ? 'pair'
    : input.reopened && input.reopened !== 'pair' ? input.reopened
    : HOST_STAGE_STEPS.find((step) => !done.has(step) && !input.skipped.has(step)) ?? null
  const isGithubWorking = GITHUB_FOLLOW_THROUGH.some((id) => input.runningStep === id)
  const hasGithubFailed = GITHUB_FOLLOW_THROUGH.some((id) => input.failedStep === id)
  const entries = HOST_STAGE_STEPS.map((step, index): HostStageEntry => {
    const number = index + 1
    if (step === open) {
      const isConnecting = step === 'pair' && (input.pairingView === 'connecting' || input.pairingBusy)
      return { step, number, status: 'open', marker: isConnecting ? 'spinner' : 'number' }
    }
    if (done.has(step)) {
      const marker = step === 'github' && hasGithubFailed ? 'failed' : step === 'github' && isGithubWorking ? 'spinner' : 'check'
      return { step, number, status: 'done', marker }
    }
    // A skipped step folds like a done one, with its number: Edit opens it again.
    if (input.skipped.has(step)) return { step, number, status: 'done', marker: 'number' }
    return { step, number, status: 'next', marker: 'number' }
  })
  return { entries, open, done }
}

/**
 * A failed follow-through of GitHub (git credentials, the GitHub CLI, gh auth):
 * the step to run again, and why it failed, for the GitHub line.
 */
export function githubFollowThroughFailure(readiness: HostReadiness | null, stepError: { step: string; message: string } | null | undefined): { id: OnboardingStepId; message: string } | null {
  if (!stepError) return null
  const step = hostOnboardingSteps({ readiness }).find((entry) => entry.automatic && entry.id === stepError.step)
  return step ? { id: step.id, message: `${step.label}: ${stepError.message}` } : null
}

/** The end of the header line. */
export function hostStageProgress(open: HostStageStep | null): string {
  return open ? `Step ${HOST_STAGE_STEPS.indexOf(open) + 1} of ${HOST_STAGE_STEPS.length}.` : 'is ready.'
}

export interface HostStageCopyFacts {
  hostName: string
  /** The pairing title and line while pairing (`onboardingHeading`). */
  pairing: { title: string; subtitle: string }
  /** The agents signed in on the host, by name. */
  readyAgents: readonly string[]
  /** Why GitHub's follow-through failed. */
  githubFailure: string | null
  isSkipped: boolean
}

export interface HostStageCopy {
  title: string
  detail: string
  editLabel: 'Edit' | 'Change'
}

export function hostStageCopy(entry: HostStageEntry, facts: HostStageCopyFacts): HostStageCopy {
  const { hostName } = facts
  switch (entry.step) {
    case 'pair':
      if (entry.status === 'open') return { title: facts.pairing.title, detail: facts.pairing.subtitle, editLabel: 'Edit' }
      return { title: `Pair ${hostName}`, detail: entry.status === 'done' ? `${hostName} trusts this device.` : 'With SSH or a pairing code.', editLabel: 'Edit' }
    case 'agents':
      if (entry.status === 'open') return { title: 'Connect agents', detail: `Sign in on ${hostName}. One is enough to start.`, editLabel: 'Edit' }
      if (facts.isSkipped && entry.marker === 'number') return { title: 'Connect agents', detail: 'Skipped. No session can start there until one is connected.', editLabel: 'Edit' }
      if (entry.status === 'done') return { title: 'Agents', detail: facts.readyAgents.join(', '), editLabel: 'Edit' }
      return { title: 'Connect agents', detail: 'Claude Code, Codex, or Google Antigravity.', editLabel: 'Edit' }
    case 'github':
      if (entry.status === 'open') return { title: 'Connect GitHub', detail: `So ${hostName} can clone, push and open pull requests as you.`, editLabel: 'Change' }
      if (facts.isSkipped && entry.marker === 'number') return { title: 'Connect GitHub', detail: 'Skipped. Agents there cannot push or open pull requests.', editLabel: 'Edit' }
      if (entry.marker === 'failed') return { title: 'GitHub', detail: facts.githubFailure ?? 'Setting up git did not finish.', editLabel: 'Change' }
      if (entry.marker === 'spinner') return { title: 'GitHub', detail: 'Connected. Setting up git and the GitHub CLI…', editLabel: 'Change' }
      if (entry.status === 'done') return { title: 'GitHub', detail: 'Connected. Agents push and open pull requests as you.', editLabel: 'Change' }
      return { title: 'Connect GitHub', detail: 'So agents there can push and open pull requests.', editLabel: 'Change' }
  }
}

export interface HostStageFooterFacts {
  open: HostStageStep | null
  hostName: string
  done: ReadonlySet<HostStageStep>
  /** The pair step's one action, by its pairing view; null while there is nothing to press. */
  pairingAction: { label: string; disabled: boolean } | null
}

/**
 * The footer: a hint, Skip (`esc`), and the one primary (`↵`). Skip leaves a
 * step for later; on the pair step it closes, because nothing comes before it.
 */
export function hostStageFooter(facts: HostStageFooterFacts): Footer {
  switch (facts.open) {
    case 'pair':
      return facts.pairingAction
        ? { hint: 'Nothing is installed until it joins.', primaryLabel: facts.pairingAction.label, primaryEnabled: !facts.pairingAction.disabled, secondary: 'skip' }
        : { hint: `Connecting to ${facts.hostName}…`, primaryLabel: 'Continue', primaryEnabled: false, secondary: 'skip' }
    case 'agents':
      return { hint: 'You can add the others whenever you like.', primaryLabel: 'Continue', primaryEnabled: facts.done.has('agents'), secondary: 'skip' }
    case 'github':
      return { hint: 'You can connect it later in the host’s settings.', primaryLabel: 'Continue', primaryEnabled: facts.done.has('github'), secondary: 'skip' }
    case null:
      return { hint: `Choose ${facts.hostName} in Run on to start a session there.`, primaryLabel: 'Done', primaryEnabled: true, secondary: null }
  }
}
