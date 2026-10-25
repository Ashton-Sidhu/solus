import type { SessionStatus, StatusCardState, StatusCardStep } from './types'

/** The host's card for the worktree it prepares before a new run starts. */
export function worktreeSetupCardId(sessionId: string): string {
  return `worktree-${sessionId}`
}

/** The steps of a new worktree, in order, after any copy of the repository.
 *  The fetch and the checkout can be active at the same time. */
export const WORKTREE_SETUP_STEPS = [
  { id: 'fetch', label: 'Fetch base branch' },
  { id: 'checkout', label: 'Check out files' },
  { id: 'submodules', label: 'Init submodules' },
] as const satisfies ReadonlyArray<Pick<StatusCardStep, 'id' | 'label'>>

/** The last step of every host setup card: the workspace links and the agent starts. */
export const AGENT_SETUP_STEP = { id: 'agent', label: 'Start agent' } as const satisfies Pick<StatusCardStep, 'id' | 'label'>

/**
 * The host's worktree card at its first step, before git does any work. The
 * host publishes this card when it starts the worktree; a client shows the same
 * card at Send, so the host's card replaces it with no change.
 */
export function pendingWorktreeSetupCard(sessionId: string, baseBranch: string): StatusCardState {
  return {
    id: worktreeSetupCardId(sessionId),
    title: 'Preparing worktree…',
    icon: 'git-branch',
    status: 'active',
    output: [`Creating worktree from ${baseBranch}`],
    worktreeBaseBranch: baseBranch,
    // The host stamps the first step's start time on its next card.
    steps: [...WORKTREE_SETUP_STEPS, AGENT_SETUP_STEP].map((step, i): StatusCardStep => ({ ...step, status: i === 0 ? 'active' : 'pending' })),
  }
}

export function isWorktreeSetupCard(card: StatusCardState): boolean {
  return card.id.startsWith('worktree-')
}

const WORKTREE_STEP_IDS: ReadonlySet<string> = new Set(WORKTREE_SETUP_STEPS.map((step) => step.id))

/**
 * Whether the person can stop this setup and work in the project folder: the
 * host makes a worktree now. A Run on card keeps the client's id when the
 * host's card joins it, so its steps decide.
 */
export function mayWorkLocallyDuringSetup(card: StatusCardState): boolean {
  return card.status === 'active'
    && (isWorktreeSetupCard(card) || card.id.startsWith('remote-dispatch-'))
    && card.steps.some((step) => step.status === 'active' && WORKTREE_STEP_IDS.has(step.id))
}

/**
 * An active setup card once the session left `connecting`. A run that started
 * or ended means setup succeeded; any other status means setup stopped. A live
 * card and a replayed card settle the same way.
 */
export function settleSetupCard(card: StatusCardState, status: SessionStatus | undefined): StatusCardState {
  const succeeded = status === 'running' || status === 'idle' || status === 'completed'
  const isWorktree = card.icon === 'git-branch'
  return {
    ...card,
    status: succeeded ? 'done' : 'error',
    title: succeeded
      ? (isWorktree ? 'Worktree ready' : 'Setup complete')
      : (isWorktree ? 'Worktree setup stopped' : 'Setup stopped'),
    // A skipped step and a step with a warning keep their status: setup went on past them.
    steps: card.steps.map((step) => ({
      ...step,
      status: step.status === 'active' || step.status === 'pending'
        ? (succeeded ? 'done' : step.status === 'active' ? 'error' : 'pending')
        : step.status,
    })),
  }
}

/** How long a step took, from the host's times. Undefined while it runs or
 *  when the card has no times. */
export function stepDurationMs(step: StatusCardStep): number | undefined {
  return step.startedAt !== undefined && step.endedAt !== undefined ? step.endedAt - step.startedAt : undefined
}

/** From the first step's start to the last step's end, from the host's times.
 *  Steps that ran at the same time count once. */
export function setupSpanMs(card: StatusCardState): number | undefined {
  const starts = card.steps.flatMap((step) => step.startedAt ?? [])
  const ends = card.steps.flatMap((step) => step.endedAt ?? [])
  if (!starts.length || !ends.length) return undefined
  return Math.max(...ends) - Math.min(...starts)
}

/** `0.4s`, `2.1s`, `1m 04s` — the rail is narrow, so nothing wider. */
export function formatStepDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const seconds = ms / 1000
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`
}

/** The last lines of setup output in a fixed window of `size` rows, oldest first. */
export function setupOutputWindow(output: readonly string[] | undefined, size = 4): string[] {
  const lines = output?.slice(-size) ?? []
  // A non-breaking space keeps an empty row at its height.
  return [...Array<string>(size - lines.length).fill(''), ...lines].map((line) => line || ' ')
}
