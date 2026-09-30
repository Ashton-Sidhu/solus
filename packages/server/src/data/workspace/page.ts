import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { SolusApiError } from '../../admission/workspace-error'

/** Where the previous page ended. Access is checked again on every page, so the cursor carries only a position. */
const cursorSchema = z.strictObject({
  time: z.number().int(),
  id: z.string().max(1024),
  hostId: z.string().max(256).optional(),
  /** A continuation inside one long transcript message. */
  offset: z.number().int().min(0).optional(),
  /** The end of an Insights window, fixed on the first page. */
  until: z.number().int().optional(),
})
export type PageCursor = z.infer<typeof cursorSchema>
export interface RecordPage<T> { items: T[]; nextCursor: string | null }

export function readCursor(cursor: string | undefined): PageCursor | undefined {
  if (cursor === undefined) return undefined
  const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8').trim() || 'null'))
  if (!parsed.success) throw new SolusApiError(400, 'INVALID_CURSOR', 'Invalid cursor.')
  return parsed.data
}

export function writeCursor(position: PageCursor): string {
  return Buffer.from(JSON.stringify(position)).toString('base64url')
}

/** Rows newer than the cursor position come first; the caller read `limit + 1` rows to learn whether a next page exists. */
export function seekClause(time: SQL, id: SQL, after: PageCursor | undefined): SQL {
  return after ? sql`(${time}, ${id}) < (${after.time}, ${after.id})` : sql`1 = 1`
}

export function pageOf<T>(rows: T[], limit: number, positionOf: (item: T) => PageCursor): RecordPage<T> {
  const items = rows.slice(0, limit)
  const last = items.at(-1)
  return { items, nextCursor: last && rows.length > limit ? writeCursor(positionOf(last)) : null }
}
