import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { searchableMessageText } from '@solus/contracts/session-search'
import type { Db } from './database'

const rowSchema = z.object({ organization_id: z.string(), session_id: z.string(), position: z.coerce.number(), message: z.string() })
const contentSchema = z.object({ content: z.string().optional(), role: z.string().optional(), toolName: z.string().optional(), parentToolUseId: z.string().optional() }).nullable()

/** One-time backfill of derived text after the schema migration. Original rows stay intact. */
export async function rebuildMirroredSearch(db: Db): Promise<void> {
  for (;;) {
    const rows = rowSchema.array().parse(await db.all(sql`SELECT organization_id, session_id, position, message FROM session_transcripts WHERE search_text = '' LIMIT 300`))
    if (!rows.length) return
    await db.transaction(async tx => {
      for (const row of rows) {
        const text = searchableMessageText(contentSchema.parse(JSON.parse(row.message))) || ' '
        await tx.run(sql`UPDATE session_transcripts SET search_text = ${text} WHERE organization_id = ${row.organization_id} AND session_id = ${row.session_id} AND position = ${row.position}`)
      }
    })
  }
}
