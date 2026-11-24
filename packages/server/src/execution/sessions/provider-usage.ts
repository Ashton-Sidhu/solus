import type { AgentId } from '@solus/contracts/types'
import { HOST_LOGIN_SEAT, type Seat } from '@solus/contracts/seats'
import { seatFor, type Actor } from '../../admission/actor'
import { seatKey } from '../seats/seat-manager'
import type { RateLimitState } from '../rate-limits'
import type { UsageLimitsStore } from '../../usage/usage-store'

/** A provider that is out of usage, and when it opens again (epoch seconds), when that is known. */
export interface ProviderSpent {
  resetsAt: number | null
}

/** The seat a session runs under. A session that acted for no person runs on the host login. */
export function seatOf(readers: Pick<ProviderUsageReaders, 'actorOf'>, sessionId: string | undefined): Seat {
  const actor = sessionId ? readers.actorOf(sessionId) : undefined
  return actor ? seatFor(actor) : HOST_LOGIN_SEAT
}

/** What the host reads to tell whether a provider is out of usage for a seat. */
export interface ProviderUsageReaders {
  /** The quota windows of the host login. A member's seat has its own, which this store does not hold. */
  usage: Pick<UsageLimitsStore, 'spentUntil'>
  /** The limits that hold sessions on this host now. */
  held: Pick<RateLimitState, 'held'>
  providerOf(sessionId: string): AgentId | undefined
  /** Whom the session's latest turn acted for. */
  actorOf(sessionId: string): Actor | undefined
}

/**
 * Whether `provider` is out of usage for `seat`, and until when.
 *
 * Two signs count. A quota window of the host login at 100% whose reset is
 * still ahead. And a limit that holds a session of the same seat on that
 * provider now: a provider can refuse turns below 100% (a Claude weekly limit
 * at 95%), so the percent alone misses real limits. A member's seat counts
 * only its held limits, because the host keeps no quota numbers for it here.
 * With more than one sign, the provider opens again at the latest reset.
 */
export function providerSpent(readers: ProviderUsageReaders, provider: AgentId, seat: Seat, now = Date.now()): ProviderSpent | null {
  const key = seatKey(seat)
  const signs: ProviderSpent[] = readers.held.held(now / 1000)
    .filter(({ sessionId }) => readers.providerOf(sessionId) === provider && seatKey(seatOf(readers, sessionId)) === key)
    .map(({ event }) => ({ resetsAt: event.resetsAt }))
  const quota = key === seatKey(HOST_LOGIN_SEAT) ? readers.usage.spentUntil(provider, now) : null
  if (quota) signs.push(quota)
  if (signs.length === 0) return null
  const resets = signs.flatMap((sign) => (sign.resetsAt === null ? [] : [sign.resetsAt]))
  return { resetsAt: resets.length > 0 ? Math.max(...resets) : null }
}
