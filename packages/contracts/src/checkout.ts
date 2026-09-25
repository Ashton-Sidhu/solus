import type { GitCheckout } from './types'

export interface CheckoutRename {
  previousBranch: string
  branch: string
  at: number
}

/** One host's current identity for a checkout. The path survives branch renames. */
export interface CheckoutState {
  cwd: string
  checkout: GitCheckout | null
  revision: number
  lastRename?: CheckoutRename
}

export interface CheckoutChange {
  generation: string
  state: CheckoutState
  cause: 'created' | 'renamed' | 'observed'
}

export interface CheckoutSnapshot {
  generation: string
  revision: number
  states: CheckoutState[]
}
