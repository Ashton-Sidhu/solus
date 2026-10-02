import type { StatusCardState, StatusCardStep } from '@solus/contracts/types'

const PR_CHECKOUT_STEPS: { id: string; label: string }[] = [
  { id: 'checkout', label: 'Checking out the PR worktree' },
  { id: 'session', label: 'Starting the session' },
]

/**
 * The setup card a session started from a pull request shows while the PR's
 * worktree is prepared. The conversation opens before the checkout exists, so
 * this card is where the wait is seen — and, when it fails, why.
 */
export function buildPrCheckoutCard(
  prNumber: number,
  phase: 'checkout' | 'ready',
  error?: string,
): StatusCardState {
  // Checking out is the only step that waits; the session starts with the send.
  const activeIndex = phase === 'ready' ? PR_CHECKOUT_STEPS.length : 0
  return {
    id: `pr-checkout-${prNumber}`,
    title: error
      ? `Couldn't check out PR #${prNumber}`
      : phase === 'ready'
        ? `PR #${prNumber} checked out`
        : `Checking out PR #${prNumber}…`,
    icon: 'git-branch',
    status: error ? 'error' : phase === 'ready' ? 'done' : 'active',
    steps: PR_CHECKOUT_STEPS.map((step, index) => {
      const row: StatusCardStep = {
        id: step.id,
        label: step.label,
        status: index < activeIndex
          ? 'done'
          : index === activeIndex
            ? (error ? 'error' : 'active')
            : 'pending',
      }
      if (error && index === activeIndex) row.detail = error
      return row
    }),
  }
}
