import type { HostReadiness, SetupAgent } from '../../../../shared/types'
import { hasGithubCliScopes } from '../../../../shared/github-auth'

export type OnboardingStepId =
  | 'github'
  | 'credential-helper'
  | 'gh-cli'
  | 'gh-auth'
  | 'providers'

export interface OnboardingStep {
  id: OnboardingStepId
  label: string
  /** What this step buys, in the user's terms rather than the command's. */
  detail: string
  /**
   * The same thing at length, for the one step the stage is asking about right
   * now. `detail` has to fit a list row; this doesn't.
   */
  why: string
  /**
   * Non-interactive steps are run and reported, never asked about — there is
   * nothing to decide, and a prompt per step turns setup into an interrogation.
   */
  automatic: boolean
  done: boolean
  /** The step that has to land first, or null when this one can run now. */
  blockedBy: OnboardingStepId | null
}

/**
 * The providers a host can be given, in the order they are offered. Both are
 * always listed: one is enough to take a session, and the other has to stay
 * one click away rather than disappearing because the host arrived with a CLI.
 */
export const SETUP_PROVIDERS: Array<{ id: SetupAgent; label: string }> = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
]

/** What still has to happen before a provider can take a session on this host. */
export type ProviderSetupAction = 'install' | 'authenticate'

/**
 * Adding a provider promises a usable provider, not a CLI binary that springs
 * another sign-in on the user afterwards, so both halves belong to one action.
 * A provider already on the host skips straight to authenticating.
 *
 * `force` signs an already signed-in provider in again. Readiness reports what
 * the host's CLI said when it was last asked, and credentials expire without
 * anything on the host noticing, so a row that reads as fine still has to be
 * able to run the one flow that repairs it.
 */
export function providerSetupActions(
  state: { installed: boolean; signedIn: boolean },
  opts?: { force?: boolean },
): ProviderSetupAction[] {
  if (!state.installed) return ['install', 'authenticate']
  if (state.signedIn && !opts?.force) return []
  return ['authenticate']
}

/** The brand marks the rail can draw, keyed the same as the rows that use them. */
export type ProviderLogoId = 'github' | 'claude' | 'codex'

/**
 * One provider in a choice card, already resolved to what it says and what
 * pressing it does. Built here rather than in markup so the same card renders
 * git hosts and coding providers without knowing the difference between them.
 */
export interface ProviderRow {
  id: ProviderLogoId
  label: string
  /** The line under the name: where the account lives, or where this one stands. */
  detail: string
  state: 'busy' | 'done' | 'available'
  actionLabel?: string
  /** Some rows have their own reason to be unavailable. */
  disabled?: boolean
  run?: () => void
  /** A quieter action a settled row still offers, drawn beside its check mark. */
  secondary?: { label: string; run: () => void }
}

export interface GitHostRowsInput {
  readiness: HostReadiness | null
  /** True while the GitHub device flow is waiting on the browser. */
  connecting: boolean
  /** True while any step is running, including this one. */
  busy: boolean
  connect: () => void
}

export function gitHostRows(input: GitHostRowsInput): ProviderRow[] {
  const { readiness, connecting, busy, connect } = input
  const github = readiness?.github
  const needsReconnect =
    !!github?.solusToken && !hasGithubCliScopes(github.solusScopes)
  return [
    {
      id: 'github',
      label: 'GitHub',
      detail: needsReconnect
        ? 'Reconnect to authorize the GitHub CLI'
        : github?.solusToken
        ? `Connected · ${github.solusLogin ?? 'this host'}`
        : connecting
          ? 'Waiting on your browser…'
          : 'github.com · repo and project access',
      state: needsReconnect
        ? 'available'
        : github?.solusToken
          ? 'done'
          : connecting
            ? 'busy'
            : 'available',
      actionLabel: needsReconnect ? 'Reconnect' : 'Connect',
      disabled: busy,
      run: connect,
    },
  ]
}

export interface CodingProviderRowsInput {
  readiness: HostReadiness | null
  /** Each provider owns its setup state so installs and sign-ins can overlap. */
  stages: Record<SetupAgent, ProviderSetupAction | null>
  add: (agent: SetupAgent, opts?: { force?: boolean }) => void
}

/**
 * Every provider keeps a row whatever the others have done. The step is
 * satisfied by one of them, so filtering the list to what a host already had hid
 * Claude Code outright on a host that arrived with Codex, and left "add the
 * other later" with nowhere to click.
 */
export function codingProviderRows(input: CodingProviderRowsInput): ProviderRow[] {
  const { readiness, stages, add } = input
  return SETUP_PROVIDERS.map(({ id, label }) => {
    const state = readiness?.agents?.[id] ?? { installed: false, signedIn: false }
    const stage = stages[id]
    if (stage)
      return {
        id,
        label,
        detail: stage === 'install' ? 'Installing…' : 'Waiting on your browser…',
        state: 'busy',
      }
    const actions = providerSetupActions(state)
    if (actions.length === 0)
      return {
        id,
        label,
        detail: 'Installed and signed in',
        state: 'done',
        // Signed in is the last thing this host was able to report, not a
        // promise the token still works. Someone who suspects a stale sign-in,
        // or wants a different account, has this instead of a dead check mark.
        secondary: { label: 'Sign in again', run: () => add(id, { force: true }) },
      }
    return {
      id,
      label,
      detail: state.installed ? 'Installed · not signed in' : 'Not installed',
      state: 'available',
      actionLabel: actions.includes('install') ? 'Add' : 'Sign in',
      run: () => add(id),
    }
  })
}

export interface HostOnboardingInput {
  readiness: HostReadiness | null
}

/**
 * The rail contains only setup the user has to choose. Host naming and clone
 * location already have defaults; git and commit identity are repaired at the
 * point of use. The credential helper and `gh auth` still follow GitHub because
 * both hand its stored token to something.
 *
 * Every step reports `done` from a fresh readiness probe rather than from having
 * been run, so a host set up by hand reads as ready without touching anything.
 */
export function hostOnboardingSteps(input: HostOnboardingInput): OnboardingStep[] {
  const { readiness } = input
  // Readiness crosses a version boundary — a host can be running an older server
  // build than the client, and answers with whatever shape it knew. Every field
  // is reached defensively so a missing one reads as "not done yet" rather than
  // throwing and taking the whole host directory down with it.
  const hasToken = !!readiness?.github?.solusToken
  const hasCliToken =
    hasToken && hasGithubCliScopes(readiness?.github?.solusScopes)
  const hasGhCli = !!readiness?.github?.ghCli
  const agents = Object.values(readiness?.agents ?? {})
  // One runnable provider is all a host needs to take a session. Installing and
  // signing in are not split into two steps: a host that arrived with a CLI
  // already on it would mark "install" done and then only ever offer the
  // provider it found, leaving the other one nowhere to be added.
  const hasSignedInProvider = agents.some(
    (provider) => provider.installed && provider.signedIn,
  )

  return [
    {
      id: 'github',
      label: 'Connect GitHub',
      detail: 'A token of its own — nothing carries over from this machine.',
      why: 'This host needs a token of its own — nothing carries over from this machine. It also finishes the two carried-over items still waiting on GitHub.',
      automatic: false,
      done: hasCliToken,
      blockedBy: null,
    },
    {
      id: 'credential-helper',
      label: 'Teach git to use it',
      detail: 'So pushes from this host stop asking for a password.',
      why: 'Hands the GitHub token to git so pushes from this host stop asking for a password.',
      automatic: true,
      done: !!readiness?.git?.credentialHelper,
      blockedBy: hasToken ? null : 'github',
    },
    {
      id: 'gh-cli',
      label: 'Install the GitHub CLI',
      detail: 'The binary the next step signs in.',
      why: 'Installs the GitHub CLI, which is what the agent runs to open a pull request.',
      automatic: true,
      done: hasGhCli,
      blockedBy: null,
    },
    {
      id: 'gh-auth',
      label: 'Authorize the gh CLI',
      detail: 'What the agent uses to open a pull request.',
      why: 'Signs the gh CLI in with the same token, which is what the agent uses to open a pull request.',
      automatic: true,
      done: !!readiness?.github?.ghAuthenticated,
      blockedBy: !hasCliToken ? 'github' : !hasGhCli ? 'gh-cli' : null,
    },
    {
      id: 'providers',
      label: 'Add a coding provider',
      detail: 'Claude Code or Codex — the CLI a session runs through.',
      why: 'Sessions run through Claude Code or Codex. Adding one installs its CLI if the host is missing it and signs it in — once, in your browser. You can add the other later.',
      automatic: false,
      done: hasSignedInProvider,
      blockedBy: null,
    },
  ]
}

/**
 * Enough of a pairing fingerprint to recognise, short enough to sit in a meta
 * line beside the platform and address. Anything already short is left alone.
 */
export function shortFingerprint(fingerprint: string | undefined): string | null {
  if (!fingerprint) return null
  const bare = fingerprint.replace(/^SHA256:/i, '')
  return bare.length > 12 ? `${bare.slice(0, 4)}…${bare.slice(-4)}` : bare
}

/** A thing the host already has, stated so the user can see what it didn't cost them. */
export interface CarriedOverFact {
  id: string
  title: string
  detail: string
  done: boolean
}

export interface OnboardingRailInput {
  readiness: HostReadiness | null
  hostName: string
  hostUrl?: string
  fingerprint?: string
  stepError?: { step: string; message: string; provider?: SetupAgent } | null
}

/**
 * The complete read model for the onboarding rail. Keeping its ordering,
 * failure routing and weighted progress together prevents the sidebar and main
 * panel from independently deciding that a blocked host is already done.
 */
export function onboardingRailModel(input: OnboardingRailInput) {
  const steps = hostOnboardingSteps({ readiness: input.readiness })
  const facts = hostCarriedOverFacts({
    readiness: input.readiness,
    hostName: input.hostName,
  })
  const decisions = steps.filter((step) => !step.automatic)
  const automaticSteps = steps.filter((step) => step.automatic)
  const blockingFailureStep = input.stepError
    ? decisions.find((step) => step.id === input.stepError?.step && !step.done)
    : undefined
  const current =
    blockingFailureStep ??
    decisions.find((step) => !step.done && !step.blockedBy) ??
    null
  const currentNumber = current ? decisions.indexOf(current) + 1 : 0
  const doneDecisions = decisions.filter(
    (step) => step.done && step.id !== blockingFailureStep?.id,
  )
  const upcoming = decisions.filter(
    (step) => step !== current && !step.done,
  )
  const failure = input.stepError &&
    (input.stepError.step === 'providers' || input.stepError.step === current?.id)
      ? input.stepError
      : null
  const carriedTotal = facts.length + automaticSteps.length
  const carriedDone =
    facts.filter((fact) => fact.done).length +
    automaticSteps.filter((step) => step.done).length
  // Decisions are the only items that cost user attention, so each has twice
  // the weight of a carried-over fact or automatic follow-through.
  const weightedTotal = carriedTotal + decisions.length * 2
  const percentDone = weightedTotal === 0
    ? 100
    : Math.round(
        ((carriedDone + doneDecisions.length * 2) / weightedTotal) * 100,
      )
  const hostMeta = [
    input.readiness?.platform,
    input.hostUrl,
    shortFingerprint(input.fingerprint),
  ]
    .filter(Boolean)
    .join(' · ')

  return {
    steps,
    facts,
    decisions,
    automaticSteps,
    current,
    currentNumber,
    doneDecisions,
    upcoming,
    failure,
    carriedTotal,
    carriedDone,
    percentDone,
    hostMeta,
  }
}

/**
 * Read off readiness rather than run: these are the parts of a host that were
 * settled by pairing with it. A gap stays in the list as an undone row — a host
 * without git should read as a visible gap, not as a silently shorter list.
 *
 * Reached as defensively as `hostOnboardingSteps` — same version boundary.
 */
export function hostCarriedOverFacts(
  input: { readiness: HostReadiness | null; hostName: string },
): CarriedOverFact[] {
  const { readiness, hostName } = input
  const projectsRoot = readiness?.projectsRoot
  const git = readiness?.git
  const identity = git?.identity

  return [
    {
      id: 'name',
      title: `Named ${hostName}`,
      detail: 'from its hostname',
      done: true,
    },
    {
      id: 'projects',
      title: projectsRoot ? `Projects land in ${projectsRoot}` : 'No clone location yet',
      detail: projectsRoot ? 'matched to this Mac' : 'this host has not reported one',
      done: !!projectsRoot,
    },
    {
      id: 'git',
      title: git?.installed ? 'git is already here' : "git isn't installed here",
      detail: git?.installed
        ? 'nothing to install'
        : readiness?.installGit?.display ?? 'install it on the host to clone',
      done: !!git?.installed,
    },
    {
      id: 'identity',
      title: 'Commit identity copied',
      detail: identity ? `${identity.name} · ${identity.email}` : 'not set on this host',
      done: !!identity,
    },
  ]
}

/**
 * What the host row says at a glance, so "Set up" isn't hidden behind a click.
 * Only the choices that stop the intended hosted workflow count as blocking.
 * Git and identity failures are repaired where the user first needs them.
 */
export interface HostReadinessSummary {
  ready: boolean
  remaining: number
}

export function hostReadinessSummary(steps: OnboardingStep[]): HostReadinessSummary {
  const remaining = steps.filter((step) => !step.done).length
  const blocking = steps.filter((step) => !step.done && BLOCKING_STEPS.has(step.id)).length
  return { ready: blocking === 0, remaining }
}

/** Without these a hosted session either can't start or can't return its work. */
const BLOCKING_STEPS = new Set<OnboardingStepId>(['github', 'providers'])
