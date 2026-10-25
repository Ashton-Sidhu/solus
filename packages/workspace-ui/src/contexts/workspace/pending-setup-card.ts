import { pendingWorktreeSetupCard } from '@solus/contracts/setup-card'
import type { Session } from '@solus/contracts/types'
import { mergeRemoteDispatchProgress } from '../../lib/remote-dispatch-card'
import { checkoutGit, pendingClone, worktreeBaseBranch } from './run-location'

/**
 * Show the host's worktree card at Send, before the host answers. The host
 * makes a worktree when the run names a base branch and its checkout is not a
 * worktree already; its own card has the same id and replaces this one. When
 * the host makes no worktree, the session leaves `connecting` and the reducer
 * removes the card, as it removes the host's card.
 */
export function showPendingWorktreeSetup(session: Session): void {
  const baseBranch = worktreeBaseBranch(session.run)
  // A clone's host card begins with the repository it copies, which the
  // remote dispatch card already shows as active.
  if (!baseBranch || checkoutGit(session.run)?.worktreePath || pendingClone(session.run)) return
  session.statusCard = mergeRemoteDispatchProgress(session.statusCard, pendingWorktreeSetupCard(session.id, baseBranch))
}
