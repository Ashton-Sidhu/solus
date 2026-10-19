import { z } from 'zod'
import { SolusApiError } from '../../admission/workspace-error'

/**
 * A request that went over the database's limits answers a retryable API error.
 * The limits are each Postgres connection's (`PostgresDb`), so a request sends
 * nothing to set them; a statement they cancel is rolled back.
 */
export function withWorkspaceBudget<A extends unknown[], R>(operation: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args) => {
    try {
      return await operation(...args)
    } catch (error) {
      // Drizzle wraps driver errors. Read a bounded cause chain so cancellation keeps its stable API code.
      let cause = error
      for (let depth = 0; depth < 4; depth++) {
        const parsed = z.object({ code: z.string() }).safeParse(cause)
        if (parsed.success && ['57014', '55P03', '25P03'].includes(parsed.data.code)) {
          throw new SolusApiError(503, 'CAPABILITY_UNAVAILABLE', 'The database request exceeded its time budget. Try again shortly.', 1)
        }
        if (!(cause instanceof Error)) break
        cause = cause.cause
      }
      throw error
    }
  }
}
