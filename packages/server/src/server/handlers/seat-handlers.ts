import { seatConnectCodeRequestSchema, seatConnectTokenRequestSchema, seatProviderRequestSchema, seatRemoveRequestSchema } from '@solus/contracts/seats'
import type { SeatConnector } from '../../seats/seat-connect'
import { seatUserFor, type SeatManager } from '../../seats/seat-manager'
import type { SolusServer } from '../server'

/**
 * The caller's own provider seats on this host (docs/plans/provider-seats.md
 * §3.6). The seat user comes from the principal, never from the request: the host
 * owner's seat is the host login, a member's is their own, and a guest is refused
 * by the access policy. Removal is the administrator's.
 */
export function registerSeatHandlers(server: SolusServer, deps: { seats: SeatManager; connector: SeatConnector }): void {
  server.register('seatList', (_args, ctx) => deps.seats.list(seatUserFor(ctx.principal)))

  server.register('seatConnectStart', (args, ctx) => {
    const { provider } = seatProviderRequestSchema.parse(args[0])
    return deps.connector.start(seatUserFor(ctx.principal), provider)
  })

  server.register('seatConnectSubmitCode', (args, ctx) => {
    const { provider, code } = seatConnectCodeRequestSchema.parse(args[0])
    deps.connector.submitCode(seatUserFor(ctx.principal), provider, code)
    return { submitted: true as const }
  })

  server.register('seatConnectCancel', async (args, ctx) => {
    const { provider } = seatProviderRequestSchema.parse(args[0])
    return { cancelled: await deps.connector.cancel(seatUserFor(ctx.principal), provider) }
  })

  server.register('seatConnectToken', async (args, ctx) => {
    const { provider, token } = seatConnectTokenRequestSchema.parse(args[0])
    const userId = seatUserFor(ctx.principal)
    await deps.connector.cancel(userId, provider)
    return deps.seats.storeToken(userId, provider, token)
  })

  server.register('seatDisconnect', async (args, ctx) => {
    const { provider } = seatProviderRequestSchema.parse(args[0])
    const userId = seatUserFor(ctx.principal)
    await deps.connector.cancel(userId, provider)
    return deps.seats.disconnect(userId, provider)
  })

  server.register('seatRemove', async (args) => {
    const { userId, provider } = seatRemoveRequestSchema.parse(args[0])
    for (const each of provider ? [provider] : (['claude-code', 'codex'] as const)) await deps.connector.cancel(userId, each)
    return { removed: await deps.seats.remove(userId, provider) }
  })
}
