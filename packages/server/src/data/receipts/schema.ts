import { bigint, defineTable, text } from '../../db/schema/define-table'

/**
 * One receipt per protected operation (plans/029-fresh-database-baseline.md §3.6).
 * A row claims a durable identity before the write it protects, in the same
 * transaction, so the two commit or roll back together. `namespace` names the
 * policy (`operation-receipts.ts`); `scope` is the authority the key is unique
 * under; `expires_at` is null for a receipt that never expires.
 */
export const operationReceipts = defineTable('operation_receipts', {
  scope: text({ notNull: true }),
  namespace: text({ notNull: true }),
  key: text({ notNull: true }),
  request_hash: text(),
  result_id: text(),
  expires_at: bigint(),
}, {
  primaryKey: ['scope', 'namespace', 'key'],
  indexes: [
    // Read by `sweepExpiredReceipts`: the oldest expired rows, in the order it deletes them.
    { name: 'operation_receipts_expiry', columns: ['expires_at', 'scope', 'namespace', 'key'], where: 'expires_at IS NOT NULL' },
  ],
})

export const RECEIPT_TABLES = [operationReceipts]
