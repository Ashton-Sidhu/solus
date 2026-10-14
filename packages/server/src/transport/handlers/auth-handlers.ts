import type { TokenVerdict } from '../../admission/access-tokens'
import type { Principal } from '../../admission/principal'
import { delegateFromPresentedToken, type DelegationScope } from '../../sync/delegations'
import type { SolusServer } from '../server'

/** How a token a person's client presents here makes their delegations. Absent where nothing acts for people. */
export interface AccountPresence {
  verify: (token: string) => Promise<TokenVerdict>
  establish: (subjectToken: string, scope: DelegationScope) => Promise<void>
}

/** The organization a socket works in, for the delegations its renewal makes again. */
const organizationOf = (principal: Principal): string | undefined => principal.kind === 'org-member' ? principal.organizationId : undefined

/**
 * `authRenew` (docs/adr/0001-standard-authentication.md rule 4): a client sends its next
 * access token on the open socket, and the socket lives to that token's expiry. The
 * transport that admitted the socket owns the check (`HandlerCtx.renewAccess`); a
 * connection with no expiry has nothing to renew. The next token also makes again a
 * delegation the host lost, as when another client of the person signed out.
 *
 * `accountPresent` (§6 item 5): a signed-in client on a route that did not dial with
 * its account token (a pairing, a trusted network, loopback) presents that token, and
 * the host makes the delegations it names that it does not hold. The socket's
 * principal does not change: local access stays as it was admitted (rule 10).
 */
export function registerAuthHandlers(server: SolusServer, presence: AccountPresence | null = null): void {
  server.register('authRenew', async ([{ accessToken }], ctx) => {
    if (!ctx.renewAccess) throw new Error('This connection has no access token to renew.')
    const expiresAt = await ctx.renewAccess(accessToken)
    // The renewal is sent a minute before the end, so it can wait for an exchange; a failed one does not refuse it.
    if (presence) await delegateFromPresentedToken(await presence.verify(accessToken), accessToken, [organizationOf(ctx.principal)], presence.establish).catch(() => false)
    return { expiresAt }
  })
  server.register('accountPresent', async ([{ accessToken, organizationId }]) => {
    if (!presence) return { delegated: false }
    const verdict = await presence.verify(accessToken)
    return { delegated: await delegateFromPresentedToken(verdict, accessToken, [organizationId], presence.establish) }
  })
}
