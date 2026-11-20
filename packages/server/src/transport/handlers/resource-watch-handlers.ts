import { integrationResourceWatchListRequestSchema, integrationResourceWatchStopRequestSchema } from '@solus/contracts/integrations/resource-watch'
import type { ResourceWatches } from '../../integrations/resource-watches'
import type { SolusServer } from '../server'

/** Resource watches (docs/plans/mcp-first-class.md §11.5). The access policy checks the session; the owner checks that the watch is that session's. */
export function registerResourceWatchHandlers(server: SolusServer, watches: ResourceWatches): void {
  server.register('integrationResourceWatchList', ([input]) => watches.list(integrationResourceWatchListRequestSchema.parse(input).sessionId))
  server.register('integrationResourceWatchStop', ([input]) => watches.stopWatch(integrationResourceWatchStopRequestSchema.parse(input)))
}
