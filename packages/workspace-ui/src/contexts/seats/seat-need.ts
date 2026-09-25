import type { SeatProvider, SeatStatus } from '@solus/contracts/seats'

/**
 * Whether a draft must connect a seat before its first send (docs/projects.md,
 * "Scratchpad"; decision S7): only on a host that gives this client seats of
 * its own (an organization member), once the host has listed them, and only
 * when the chosen agent's seat is not connected. Unknown is not "needed": a
 * notice must never claim a seat is missing before the host said so.
 */
export function seatNeeded(
  hasSeats: boolean | undefined,
  seats: readonly SeatStatus[] | undefined,
  provider: SeatProvider,
): boolean {
  if (hasSeats !== true || !seats) return false
  return seats.find((seat) => seat.provider === provider)?.state !== 'connected'
}
