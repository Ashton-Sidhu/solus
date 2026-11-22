import { z } from 'zod'
import { hostPairRequestSchema } from '@solus/contracts/host-pairing'
import type { HostPairings } from '../../host/host-pairings'
import { isHostOwner } from '../../admission/principal'
import type { SolusServer, HandlerCtx } from '../server'

export function registerHostPairingHandlers(server: SolusServer, pairings: HostPairings): void {
  const ownerOnly = (ctx: HandlerCtx) => {
    if (!isHostOwner(ctx.principal) || ctx.principal.via !== 'local') throw new Error('Only the local owner can pair hosts.')
  }
  server.register('hostsPair', ([input], ctx) => { ownerOnly(ctx); return pairings.pair(hostPairRequestSchema.parse(input), ctx.abortSignal) })
  server.register('hostsListPaired', (_args, ctx) => { ownerOnly(ctx); return pairings.snapshot() })
  server.register('hostsPairClient', ([id], ctx) => { ownerOnly(ctx); return pairings.forClient(z.string().min(1).parse(id)) })
  server.register('hostsForget', ([id], ctx) => { ownerOnly(ctx); return { removed: pairings.forget(z.string().min(1).parse(id)) } })
}
