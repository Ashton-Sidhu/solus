import { PRESENCE_COLOR_COUNT } from '@solus/contracts/presence'

/**
 * The stable color a user gets in every avatar stack, caret, and cursor
 * (docs/plans/multiplayer-presence.md §2). A hash of the id rather than a
 * rotating index, so a person keeps their color across hosts, restarts, and
 * whoever else is in the room. FNV-1a spreads adjacent ids (`user-1`, `user-2`)
 * across the palette, which a plain character sum would not.
 */
export function presenceColorIndex(userId: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % PRESENCE_COLOR_COUNT
}
