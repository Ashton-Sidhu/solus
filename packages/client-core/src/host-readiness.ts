/**
 * Whether this client can do work on a host now: the one answer every surface
 * reads on desktop, web, and mobile (docs/plans/host-readiness.md).
 */
export type HostReadiness = 'checking' | 'ready' | 'reconnecting' | 'unreachable' | 'refused' | 'gone'

/** What a host's link knows on its own. `gone` comes from the client's host list. */
export type LinkReadiness = Exclude<HostReadiness, 'gone'>

/** Why an `unreachable` host is unreachable. */
export type UnreachableReason = 'no-answer' | 'not-running' | 'no-address'

/** Why a `refused` host refuses: its credential was refused, or another host answers its address. */
export type RefusedReason = 'auth' | 'identity-mismatch'

/** A host down longer than this is `unreachable`; shorter, it is `checking` or `reconnecting`. */
export const UNREACHABLE_AFTER_MS = 12_000

export interface HostReadinessState {
  readiness: HostReadiness
  /**
   * Past its grace, and not ready since. A retry does not clear it: the host is
   * away until it answers, so a surface that hid its controls keeps them hidden
   * while the retry dials.
   */
  away: boolean
  /** Set only while `unreachable`. */
  unreachableReason: UnreachableReason | null
  /** Set only while `refused`. */
  refusedReason: RefusedReason | null
  /** When the host was last `ready` on this client; null if it never was. */
  lastSeenAt: number | null
}

export const CHECKING_HOST: HostReadinessState = { readiness: 'checking', away: false, unreachableReason: null, refusedReason: null, lastSeenAt: null }
export const GONE_HOST: HostReadinessState = { readiness: 'gone', away: true, unreachableReason: null, refusedReason: null, lastSeenAt: null }

/** A loader on this host may still get an answer: it waits instead of failing. */
export function isWaitingForHost(readiness: HostReadiness): boolean {
  return readiness === 'checking' || readiness === 'reconnecting'
}

/** The one thing a person can do about a host that is not ready. */
export type HostReadinessAction = 'retry' | 'start' | 'pair-again'

/** The button that does each action, on every surface. */
export const HOST_READINESS_ACTION_LABELS = {
  retry: 'Retry now',
  start: 'Start',
  'pair-again': 'Pair again',
} satisfies Record<HostReadinessAction, string>

export interface HostReadinessCopy {
  /** One word for a host list: "Online", "Offline". */
  label: string
  /** A sentence that names the host: "Raiders is offline". */
  headline: string
  detail: string | null
  action: HostReadinessAction | null
}

/** The words every surface shows for a host's readiness. */
export function hostReadinessCopy(state: HostReadinessState, hostLabel: string, now = Date.now()): HostReadinessCopy {
  switch (state.readiness) {
    case 'ready':
      return { label: 'Online', headline: `${hostLabel} is online`, detail: null, action: null }
    case 'checking':
      return { label: 'Connecting', headline: `Connecting to ${hostLabel}`, detail: null, action: null }
    case 'reconnecting':
      return { label: 'Reconnecting', headline: `Reconnecting to ${hostLabel}`, detail: null, action: null }
    case 'gone':
      return { label: 'Removed', headline: 'This machine was removed', detail: null, action: null }
    case 'refused':
      return state.refusedReason === 'identity-mismatch'
        ? { label: 'Different server', headline: `A different server answered as ${hostLabel}`, detail: 'Pair again if this is the machine you mean.', action: 'pair-again' }
        : { label: 'Needs pairing', headline: `${hostLabel} needs pairing again`, detail: 'The host no longer accepts this device.', action: 'pair-again' }
    case 'unreachable':
      switch (state.unreachableReason) {
        case 'not-running':
          return { label: 'Not running', headline: `${hostLabel} is not running`, detail: null, action: 'start' }
        case 'no-address':
          return { label: 'No address', headline: `${hostLabel} has no address yet`, detail: null, action: null }
        default:
          return {
            label: 'Offline',
            headline: `${hostLabel} is offline`,
            detail: state.lastSeenAt === null
              ? 'Solus keeps trying.'
              : `Last seen ${lastSeenText(state.lastSeenAt, now)}. Solus keeps trying.`,
            action: 'retry',
          }
      }
  }
}

/** `just now`, `4 min ago`, `2 h ago`, `3 days ago`. */
export function lastSeenText(at: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? '1 day ago' : `${days} days ago`
}
