import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDatabase } from '../../db/database'
import { SolusApiError } from '../../admission/workspace-error'

/** Limits database work, including lock waits. Timeout errors leave writes rolled back. */
export function withWorkspaceBudget<A extends unknown[], R>(operation: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args) => {
    const db = getDatabase()
    if (db.engine !== 'postgres') return operation(...args)
    try {
      return await db.transaction(async tx => {
        await tx.run(sql`SET LOCAL statement_timeout = '5s'`)
        await tx.run(sql`SET LOCAL lock_timeout = '1s'`)
        await tx.run(sql`SET LOCAL idle_in_transaction_session_timeout = '10s'`)
        return operation(...args)
      })
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
