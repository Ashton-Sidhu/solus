import { bigint, defineTable, text } from '../../db/schema/define-table'

/** Committed create receipts survive reconnect/restart and share the record transaction. */
export const solusApiReceipts = defineTable('workspace_api_receipts', {
  key: text({ primaryKey: true }),
  request_hash: text({ notNull: true }),
  resource_kind: text({ notNull: true }),
  resource_id: text(),
  expires_at: bigint({ notNull: true }),
}, { indexes: [{ name: 'workspace_api_receipts_expiry', columns: ['expires_at'] }] })

export const solusApiReceiptsSqlite = solusApiReceipts.sqlite
export const solusApiReceiptsPostgres = solusApiReceipts.pg
