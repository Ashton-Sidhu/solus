import type { SessionStatus, StatusCardState } from './types'

/** The host's card for the worktree it prepares before a new run starts. */
export function worktreeSetupCardId(sessionId: string): string {
  return `worktree-${sessionId}`
}

export function isWorktreeSetupCard(card: StatusCardState): boolean {
  return card.id.startsWith('worktree-')
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
    steps: card.steps.map((step) => ({
      ...step,
      status: succeeded ? 'done' : step.status === 'active' ? 'error' : step.status,
    })),
  }
}

/** The last lines of setup output in a fixed window of `size` rows, oldest first. */
export function setupOutputWindow(output: readonly string[] | undefined, size = 4): string[] {
  const lines = output?.slice(-size) ?? []
  // A non-breaking space keeps an empty row at its height.
  return [...Array<string>(size - lines.length).fill(''), ...lines].map((line) => line || ' ')
}
