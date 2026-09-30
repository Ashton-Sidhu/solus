import type { TurnRefusal } from '@solus/contracts/organization-scope'

/** One refused turn: where it was refused, why, and the host's own words. */
export interface RefusedTurn {
  serverId: string
  sessionId: string
  code: TurnRefusal
  /** The host's message; it names the organization when the host knew it. */
  message: string
}

/**
 * The host refused to start a turn under the organization model (plan 004
 * step 11; organization-vms §4). Only the refused client learns of it — the
 * refusal answers that person's send — so this is client-local, like the seat
 * card's request. The draft is already back in the composer.
 */
class TurnRefusalStore {
  refused = $state<RefusedTurn | null>(null)

  note(refused: RefusedTurn): void {
    this.refused = refused
  }

  visibleFor(serverId: string | undefined, sessionId: string): boolean {
    const refused = this.refused
    return refused !== null && refused.serverId === serverId && refused.sessionId === sessionId
  }

  dismiss(): void {
    this.refused = null
  }
}

export const turnRefusalStore = new TurnRefusalStore()
