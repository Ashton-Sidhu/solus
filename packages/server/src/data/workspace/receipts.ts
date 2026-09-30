import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDatabase } from '../../db/database'
import { SolusApiError } from '../../admission/workspace-error'
import { solusApiReceipts } from './schema'

const receiptSchema = z.object({ request_hash: z.string(), resource_id: z.string().nullable(), expires_at: z.number() })
const primitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
const fieldsSchema = z.record(z.string(), z.json())

/** Stable object ordering keeps an identical JSON request identical across retries. The JSON round trip drops absent optional fields. */
export function canonicalRequest(value: z.core.util.JSONType): string {
  const primitive = primitiveSchema.safeParse(value)
  if (primitive.success) return JSON.stringify(primitive.data)
  if (Array.isArray(value)) return '[' + value.map(canonicalRequest).join(',') + ']'
  const fields = fieldsSchema.parse(JSON.parse(JSON.stringify(value)))
  return '{' + Object.keys(fields).sort().map(key => JSON.stringify(key) + ':' + canonicalRequest(fields[key])).join(',') + '}'
}

export async function createWithReceipt<T extends { id: string }>(
  authority: string, kind: 'task' | 'work', key: string, request: string,
  create: () => Promise<T>, read: (id: string) => Promise<T>,
): Promise<T> {
  const receiptKey = createHash('sha256').update(JSON.stringify([authority, kind, key])).digest('hex')
  const requestHash = createHash('sha256').update(request).digest('hex')
  return getDatabase().transaction(async db => {
    const now = Date.now()
    await db.run(sql`DELETE FROM ${solusApiReceipts} WHERE key IN (SELECT key FROM ${solusApiReceipts} WHERE expires_at <= ${now} ORDER BY expires_at LIMIT 100)`)
    await db.run(sql`DELETE FROM ${solusApiReceipts} WHERE key = ${receiptKey} AND expires_at <= ${now}`)
    // A concurrent request waits on the same unique key until the winner commits or rolls back.
    const inserted = await db.run(sql`INSERT INTO ${solusApiReceipts}(key, request_hash, resource_kind, expires_at)
      VALUES (${receiptKey}, ${requestHash}, ${kind}, ${now + 24 * 60 * 60 * 1000}) ON CONFLICT(key) DO NOTHING`)
    if (!inserted.changes) {
      const receipt = receiptSchema.parse(await db.get(sql`SELECT request_hash, resource_id, expires_at FROM ${solusApiReceipts} WHERE key = ${receiptKey}`))
      if (receipt.request_hash !== requestHash) throw new SolusApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key was used with different input.')
      if (!receipt.resource_id) throw new SolusApiError(409, 'CONFLICT', 'The original operation has not completed.')
      // Re-read through current authorization. Never replay deleted/private content from a cached response.
      return read(receipt.resource_id)
    }
    const result = await create()
    await db.run(sql`UPDATE ${solusApiReceipts} SET resource_id = ${result.id} WHERE key = ${receiptKey}`)
    return result
  })
}
