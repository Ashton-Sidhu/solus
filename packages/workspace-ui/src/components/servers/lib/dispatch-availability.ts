export type DispatchAvailability =
  | { canDispatch: true }
  | { canDispatch: false; note: string }

export interface DispatchAvailabilityInput {
  /** True when the session is sitting in a git checkout at all. */
  inCheckout: boolean
  /** The checkout's `host/owner/repo`, which only a configured remote can produce. */
  repoKey: string | null
  /** False until this host's checkouts have been listed, so an unprobed host never reads as remote-less. */
  identitiesProbed: boolean
}

/**
 * Dispatch carries the repository, not the working tree: another host gets the
 * code by cloning the remote. A checkout with no remote has nothing to clone
 * from, so it is reachable only by opening the folder on that host or switching
 * to it — the picker says so rather than disappearing.
 *
 * A tab that is in no checkout yet can still be dispatched: it picks its project
 * on the host it lands on.
 */
export function dispatchAvailability(input: DispatchAvailabilityInput): DispatchAvailability {
  const { inCheckout, repoKey, identitiesProbed } = input
  if (!inCheckout || repoKey || !identitiesProbed) return { canDispatch: true }
  return {
    canDispatch: false,
    note: 'This project has no git remote, so no other host can fetch it. Open a folder there instead.',
  }
}
