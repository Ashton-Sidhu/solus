import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import type { GuestLink } from '@solus/contracts/sharing'

/**
 * A guest's visit, from the link to the one resource it opens
 * (docs/plans/multiplayer-sharing.md §4.2). The landing page reads `phase` and
 * `error`; the guest shell reads `share` and `displayName`. The boot path in
 * `main.ts` moves the phase; nothing here talks to a host.
 */
export type GuestPhase =
  /** The landing page: the visitor picks the name others will see. */
  | 'naming'
  | 'connecting'
  /** The shell is mounted on the resource. */
  | 'ready'
  /** The grant or the dial failed; `error` says how. Retry from the landing page. */
  | 'failed'
  /** The host refused the secret: the link was turned off or regenerated. */
  | 'revoked'

export type GuestShare = NonNullable<ConnectionsServerInfo['share']>

class GuestBootState {
  phase = $state<GuestPhase>('naming')
  error = $state<string | null>(null)
  displayName = $state('')
  accountUserId = $state<string | null>(null)
  serverId = $state<string | null>(null)
  share = $state<GuestShare | null>(null)
  link: GuestLink | null = null

  /** Read through a getter: the boot path assigns `phase` and would otherwise narrow it away. */
  get revoked(): boolean {
    return this.phase === 'revoked'
  }

  fail(message: string): void {
    this.phase = 'failed'
    this.error = message
  }

  revoke(): void {
    this.phase = 'revoked'
  }
}

export const guestBoot = new GuestBootState()
