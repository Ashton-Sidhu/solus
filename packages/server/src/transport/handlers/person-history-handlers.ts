import { personHistoryBatchSchema } from '@solus/contracts/person-history'
import { ownerKeyOf } from '../../admission/actor'
import type { Principal } from '../../admission/principal'
import { readPersonHistory, recordPersonHistory } from '../../data/personal-state/person-history'
import type { SolusServer } from '../server'

/**
 * A person's history (docs/plans/person-state.md §4), in this home. A host keeps
 * it for its owner in `local`; the Solus API keeps it in the caller's own person
 * scope, which every organization connection of the same account reaches.
 * `scopeOf` answers null for a caller that keeps no history here: it records
 * nothing and reads an empty history.
 */
export function registerPersonHistoryHandlers(server: SolusServer, scopeOf: (principal: Principal) => string | null): void {
  server.register('personHistoryRecord', async (args, ctx) => {
    const personKey = ownerKeyOf(ctx.actor)
    const scope = scopeOf(ctx.principal)
    if (!personKey || !scope) return
    await recordPersonHistory(scope, personKey, personHistoryBatchSchema.parse(args[0]))
  })

  server.register('personHistoryList', async (_args, ctx) => {
    const personKey = ownerKeyOf(ctx.actor)
    const scope = scopeOf(ctx.principal)
    return personKey && scope ? readPersonHistory(scope, personKey) : []
  })
}
