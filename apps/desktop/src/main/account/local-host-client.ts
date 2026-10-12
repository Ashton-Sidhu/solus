import type { AccountState } from '@solus/contracts/account-types'
import type { LocalClient } from '@solus/server/transport/local-client'
import type { AccountSession } from './account-session'
import { listDirectory } from './uplink-client'

/**
 * The desktop as an ordinary client of its own host (docs/adr/0001-standard-authentication.md
 * §2.2 rule 10, stage 6). Main holds the sign-in, so main is the client: while signed
 * in, it presents its access token for this host, and the host makes the owner's
 * delegations from it, as at the ticket door. It presents on sign-in, at start, and
 * when the host asks again (its link or organizations changed). It lends the host its
 * directory and its tokens for the owner's other hosts (docs/plans/cross-host-sessions.md).
 * On sign-out, or when the grant ends, it takes both back.
 */
export function presentAccountToLocalHost(
  session: Pick<AccountSession, 'current' | 'onChange' | 'accessToken' | 'cloudOrigin' | 'cloudRequest'>,
  host: LocalClient,
): () => void {
  let isSignedIn = false
  const present = async (): Promise<void> => {
    const hostId = host.hostId()
    if (!isSignedIn || !hostId) return
    const token = await session.accessToken({ kind: 'host', hostId })
    // A sign-out while the token was on its way presents nothing.
    if (token && isSignedIn) await host.presentToken(token)
  }
  const follow = (state: AccountState): void => {
    if ((state.kind === 'signed-in') === isSignedIn) return
    isSignedIn = state.kind === 'signed-in'
    if (isSignedIn) {
      host.lendHostAccess({
        hosts: async () => (await listDirectory(session))?.hosts ?? null,
        accessToken: (hostId) => session.accessToken({ kind: 'host', hostId }),
      })
      void present()
      return
    }
    host.lendHostAccess(null)
    host.signedOut()
  }
  const stopAsking = host.onTokenWanted(() => void present())
  const stopFollowing = session.onChange(follow)
  follow(session.current())
  return () => {
    stopAsking()
    stopFollowing()
  }
}
