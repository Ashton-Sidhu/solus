import type { SolusServer } from '../server'

/**
 * `authRenew` (docs/adr/0001-standard-authentication.md rule 4): a client sends its next
 * access token on the open socket, and the socket lives to that token's expiry. The
 * transport that admitted the socket owns the check (`HandlerCtx.renewAccess`); a
 * connection with no expiry has nothing to renew.
 */
export function registerAuthHandlers(server: SolusServer): void {
  server.register('authRenew', async ([{ accessToken }], ctx) => {
    if (!ctx.renewAccess) throw new Error('This connection has no access token to renew.')
    return { expiresAt: await ctx.renewAccess(accessToken) }
  })
}
