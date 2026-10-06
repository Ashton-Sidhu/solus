import type { ShareResource } from '@solus/contracts/sharing'
import { tallyQueries, type QueryTally } from '../db/database'
import { createLogger } from '../logger'

const log = createLogger('main', 'share-timing')

/**
 * Times one share or upload call and logs it as `share_call_timed`, with the
 * queries it sent and the time it waited for them. Share felt slow and the
 * cloud had no record of where the time went; the gap between `durationMs`
 * and `queryMs` is the time spent outside the database.
 */
export async function timeShareCall<T>(method: string, resource: ShareResource, call: () => Promise<T>): Promise<T> {
  const startedAt = performance.now()
  const tally: QueryTally = { queries: 0, queryMs: 0 }
  let failed = false
  try {
    return await tallyQueries(tally, call)
  } catch (error) {
    failed = true
    throw error
  } finally {
    log.info('share_call_timed', {
      method,
      resourceKind: resource.kind,
      resourceId: resource.id,
      durationMs: Math.round(performance.now() - startedAt),
      queries: tally.queries,
      queryMs: Math.round(tally.queryMs),
      failed,
    })
  }
}
