import type { AccountState } from '@solus/contracts/account-types'
import type { LocalClient } from '@solus/server/transport/local-client'
import { createLogger } from '@solus/server/logger'
import type { AccountSession } from './account-session'
import { issueEnrollmentTicket } from './uplink-client'

const log = createLogger('main', 'local-host-client')

/**
 * The desktop as an ordinary client of its own host (docs/adr/0001-standard-authentication.md
 * §2.2 rule 10, stage 6). Main holds the sign-in, so main is the client: while signed
 * in, it presents its access token for this host, and the host makes the owner's
 * delegations from it, as at the ticket door. A host that is not registered yet is
 * registered first (§2.2 rule 8): main gets a one-time ticket with its own account
 * token and hands it to the host, which registers with its own key. No tunnel is made.
 * It presents on sign-in, at start, and when the host asks again (its registration or
 * organizations changed, or an owner's delegation ended because another client signed out).
 * While signed in, its identity is the host's user, so the host shows the account, not
 * the machine's login name. On sign-out, or when the grant ends, it takes all of it back.
 */
export function presentAccountToLocalHost(
  session: Pick<AccountSession, 'current' | 'onChange' | 'accessToken' | 'cloudOrigin' | 'cloudRequest'>,
  host: LocalClient,
): () => void {
  let isSignedIn = false
  const register = async (): Promise<void> => {
    const ticket = await issueEnrollmentTicket(session)
    // A sign-out while the ticket was on its way registers nothing.
    if (!ticket || !isSignedIn) return
    await host.register({ ticket: ticket.ticket, directoryUrl: ticket.directoryUrl }).catch((error: unknown) => {
      log.warn('local_host_registration_failed', { error: error instanceof Error ? error.message : String(error) })
    })
  }
  const present = async (): Promise<void> => {
    if (!isSignedIn) return
    if (host.needsRegistration()) await register()
    const hostId = host.hostId()
    if (!isSignedIn || !hostId) return
    const token = await session.accessToken({ kind: 'host', hostId })
    // A sign-out while the token was on its way presents nothing.
    if (token && isSignedIn) await host.presentToken(token)
  }
  let presentedIdentity: string | null = null
  const follow = (state: AccountState): void => {
    if (state.kind === 'signed-in') {
      // The sign-in names the host's owner; a changed name or email is presented again.
      const { sub, name, email } = state.identity
      const owner = { userId: sub, email, ...(name ? { name } : {}) }
      const key = JSON.stringify(owner)
      if (key !== presentedIdentity) {
        presentedIdentity = key
        host.presentIdentity(owner)
      }
    }
    if ((state.kind === 'signed-in') === isSignedIn) return
    isSignedIn = state.kind === 'signed-in'
    if (isSignedIn) {
      void present()
      return
    }
    host.signedOut()
    presentedIdentity = null
    host.presentIdentity(null)
  }
  const stopAsking = host.onTokenWanted(() => void present())
  const stopFollowing = session.onChange(follow)
  follow(session.current())
  return () => {
    stopAsking()
    stopFollowing()
  }
}
