import { createHash } from 'node:crypto'
import { z } from 'zod'
import { getDatabase } from '../../db/database'
import { SolusApiError } from '../../admission/workspace-error'
import { claimApiCreate, completeApiCreate, type ApiCreateKind } from '../receipts/operation-receipts'

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

/**
 * Runs `create` once for a retry key under an authority; the same key again
 * answers the same resource. The receipt and the create share one transaction,
 * so a failed create leaves no receipt and the retry runs again. A duplicate is
 * read through current authorization: never a cached response, never deleted
 * or private content.
 */
export async function createWithReceipt<T extends { id: string }>(
  authority: string, kind: ApiCreateKind, key: string, request: string,
  create: () => Promise<T>, read: (id: string) => Promise<T>,
): Promise<T> {
  const requestHash = createHash('sha256').update(request).digest('hex')
  return getDatabase().transaction(async db => {
    const claim = await claimApiCreate(db, authority, kind, key, requestHash, Date.now())
    switch (claim.outcome) {
      case 'different-input': throw new SolusApiError(409, 'IDEMPOTENCY_CONFLICT', 'This key was used with different input.')
      case 'incomplete': throw new SolusApiError(409, 'CONFLICT', 'The original operation has not completed.')
      case 'duplicate': return read(claim.resultId)
      case 'claimed': {
        const result = await create()
        await completeApiCreate(db, authority, kind, key, result.id)
        return result
      }
    }
  })
}
