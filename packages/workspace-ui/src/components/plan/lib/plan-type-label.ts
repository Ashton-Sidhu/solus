import type { Plan } from '@solus/contracts/types'

/** The plan card's type word: its state. Who decided is an activity of its own (plans/012 §5). */
export function planTypeLabel(status: Plan['status']): string {
  if (status === 'pending') return 'plan'
  return status === 'accepted' ? 'plan accepted' : 'plan rejected'
}
