import { bigint, boolean, defineTable, integer, json, text } from '../../db/schema/define-table'

/**
 * A webhook (docs/plans/webhooks.md §5): its settings and its actions. The URL
 * token and the verification secret are not here; they are in the host's secret
 * store (`webhook-secrets.ts`). `copied_url_hash` is a hash of the URL the owner
 * last copied, so the editor can mark a URL that changed without storing the token.
 */
export const webhooks = defineTable('webhooks', {
  id: text({ primaryKey: true }),
  organization_id: text({ notNull: true, default: 'local' }),
  owner_key: text({ notNull: true }),
  name: text({ notNull: true }),
  enabled: boolean({ notNull: true, default: true }),
  project: text(),
  verification: json({ notNull: true }),
  replay_key: text(),
  actions: json({ notNull: true }),
  created_by: json({ notNull: true }),
  copied_url_hash: text(),
  /** Requests the forwarder lost while the host was offline (plan §2.3), summed over drains. */
  lost_count: integer({ notNull: true, default: 0 }),
  lost_at: bigint(),
  created_at: bigint({ notNull: true }),
  updated_at: bigint({ notNull: true }),
}, {
  indexes: [
    { name: 'webhooks_by_owner', columns: ['organization_id', 'owner_key'] },
    { name: 'webhooks_by_project', columns: ['project'] },
  ],
})

/** One request that came to the receiver, and what Solus did with it (plan §3.3). */
export const webhookDeliveries = defineTable('webhook_deliveries', {
  id: text({ primaryKey: true }),
  webhook_id: text({ notNull: true, references: { table: webhooks, column: 'id', onDelete: 'cascade' } }),
  received_at: bigint({ notNull: true }),
  arrived_at: bigint({ notNull: true }),
  source: text({ notNull: true }),
  outcome: text({ notNull: true }),
  reason: text(),
  replay_of: text(),
  request: json({ notNull: true }),
  verification_failure: json(),
  actions: json({ notNull: true, default: '[]' }),
}, {
  indexes: [
    { name: 'webhook_deliveries_by_webhook', columns: ['webhook_id', 'arrived_at', 'id'] },
  ],
})

// The replay keys and the proven delivery IDs a webhook has seen (plan §2.5, §3.4)
// are operation receipts in the webhook's scope (`data/receipts/operation-receipts.ts`).

export const WEBHOOK_TABLES = [webhooks, webhookDeliveries]
