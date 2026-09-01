/**
 * What to do when a browser guest's render process dies.
 *
 * A crashed `<webview>` cannot be revived in place — the element has to be
 * re-created — so recovery is automatic but bounded: a page that crashes on
 * load would otherwise re-create itself forever. Retries back off, and a burst
 * of crashes inside one window gives up and says so, rather than looping.
 */

export const GUEST_RECOVERY_WINDOW_MS = 30_000
export const GUEST_RECOVERY_MAX_ATTEMPTS = 3
export const GUEST_RECOVERY_BASE_DELAY_MS = 250

export interface GuestRecoveryState {
  attempts: number
  /** When the current burst started; a later crash starts a fresh burst. */
  windowStartedAt: number | null
}

export interface GuestRecoveryPlan {
  delayMs: number
  state: GuestRecoveryState
}

export const NO_GUEST_CRASHES: GuestRecoveryState = { attempts: 0, windowStartedAt: null }

/** The next retry, or null once this page has crashed too often to keep trying. */
export function planGuestRecovery(state: GuestRecoveryState, now: number): GuestRecoveryPlan | null {
  const startsNewWindow = state.windowStartedAt === null
    || now - state.windowStartedAt >= GUEST_RECOVERY_WINDOW_MS
  const attempts = startsNewWindow ? 0 : state.attempts
  if (attempts >= GUEST_RECOVERY_MAX_ATTEMPTS) return null
  return {
    delayMs: GUEST_RECOVERY_BASE_DELAY_MS * 2 ** attempts,
    state: {
      attempts: attempts + 1,
      windowStartedAt: startsNewWindow ? now : state.windowStartedAt,
    },
  }
}
