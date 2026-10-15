import { join } from 'node:path'
import { z } from 'zod'
import type { IntegrationConnection, IntegrationConnectionStatus } from '@solus/contracts/integration-types'
import { oauthClientSchema, type OAuthClient } from '@solus/contracts/integrations/oauth-protocol'
import { getDb } from '../db'
import { createLogger } from '../logger'
import { dataDir } from '../platform/paths'
import { secretStore } from '../platform/secrets'
import { EncryptionUnavailableError } from '../vault/vault'

/**
 * Connections (docs/plans/mcp-integrations.md §3.3, §4.1): one person's sign-in
 * to one integration. The row holds the status and the identity the server
 * reported. The credential is the vault's (`vault/vault.ts`), on this host or
 * in the person's account, and never reaches this table or a client.
 *
 * `personKey` is the person's user key (`ownerKeyOf`): the host's
 * owner is the host's user, like anyone else. There is no host-wide connection.
 */

const log = createLogger('integrations', 'connection-store.ts')

const connectionInfoSchema = z.object({
  displayName: z.string().optional(),
  email: z.string().optional(),
  avatarUrl: z.string().optional(),
})
type ConnectionInfo = z.infer<typeof connectionInfoSchema>

const connectionRowSchema = z.object({
  integration_id: z.string(),
  user_id: z.string(),
  status: z.enum(['connected', 'needs-sign-in', 'error', 'cloud-unreachable', 'needs-solus-sign-in']),
  source: z.enum(['host', 'cloud']),
  label: z.string().nullable(),
  info: z.string().nullable(),
  error: z.string().nullable(),
  updated_at: z.string(),
})
type ConnectionRow = z.infer<typeof connectionRowSchema>

const COLUMNS = 'integration_id, user_id, status, source, label, info, error, updated_at'

export interface ConnectionWrite {
  status: IntegrationConnectionStatus
  /** Left out, a write keeps where the credential lives; a new row's is the host. */
  source?: IntegrationConnection['source']
  label?: string | null
  info?: ConnectionInfo | null
  error?: string | null
}

function connectionFromRow(row: ConnectionRow): IntegrationConnection {
  const info = row.info ? connectionInfoSchema.safeParse(JSON.parse(row.info)) : null
  return {
    integrationId: row.integration_id,
    status: row.status,
    source: row.source,
    label: row.label,
    info: info?.success ? info.data : null,
    error: row.error,
    updatedAt: row.updated_at,
  }
}

export class IntegrationConnectionStore {
  list(personKey: string): IntegrationConnection[] {
    const rows = getDb().prepare(`SELECT ${COLUMNS} FROM integration_connection WHERE user_id = ? ORDER BY integration_id`).all(personKey)
    return connectionRowSchema.array().parse(rows).map(connectionFromRow)
  }

  get(integrationId: string, personKey: string): IntegrationConnection | null {
    const row = getDb().prepare(`SELECT ${COLUMNS} FROM integration_connection WHERE integration_id = ? AND user_id = ?`).get(integrationId, personKey)
    return row ? connectionFromRow(connectionRowSchema.parse(row)) : null
  }

  /** Writes the status; a field left out keeps its stored value. Returns the row as the person reads it. */
  upsert(integrationId: string, personKey: string, write: ConnectionWrite): IntegrationConnection {
    const existing = this.get(integrationId, personKey)
    const source = write.source ?? existing?.source ?? 'host'
    const label = write.label === undefined ? existing?.label ?? null : write.label
    const info = write.info === undefined ? existing?.info ?? null : write.info
    const error = write.error === undefined ? existing?.error ?? null : write.error
    getDb().prepare(`
      INSERT INTO integration_connection (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (integration_id, user_id) DO UPDATE SET status = excluded.status, source = excluded.source, label = excluded.label,
        info = excluded.info, error = excluded.error, updated_at = excluded.updated_at
    `).run(integrationId, personKey, write.status, source, label, info ? JSON.stringify(info) : null, error, new Date().toISOString())
    const saved = this.get(integrationId, personKey)
    if (!saved) throw new Error('The connection could not be saved.')
    return saved
  }

  remove(integrationId: string, personKey: string): boolean {
    return Number(getDb().prepare('DELETE FROM integration_connection WHERE integration_id = ? AND user_id = ?').run(integrationId, personKey).changes) > 0
  }

  /** Removes every person's row for an integration; returns whose rows they were, so their credentials can go too. */
  removeAllFor(integrationId: string): string[] {
    const users = z.object({ user_id: z.string() }).array()
      .parse(getDb().prepare('SELECT user_id FROM integration_connection WHERE integration_id = ?').all(integrationId))
      .map((row) => row.user_id)
    getDb().prepare('DELETE FROM integration_connection WHERE integration_id = ?').run(integrationId)
    return users
  }
}

// ── OAuth clients ───────────────────────────────────────────────────────────

/**
 * The host's registered OAuth client per integration (§4.3), in the host secret
 * store. It belongs to the integration, not to a person, so it is not the
 * vault's. A test passes its own.
 */
export interface IntegrationClients {
  client(integrationId: string): OAuthClient | null
  /** `EncryptionUnavailableError` when the store cannot save safely. */
  saveClient(integrationId: string, client: OAuthClient): void
  removeClient(integrationId: string): void
}

function clientKey(integrationId: string): string {
  return `integration-client-${integrationId}`
}

function load<T>(key: string, schema: z.ZodType<T>): T | null {
  return secretStore().loadJson(key, join(dataDir(), `${key}.bin`), schema)
}

function save<T>(key: string, value: T): void {
  const store = secretStore()
  if (!store.canSave()) throw new EncryptionUnavailableError()
  store.saveJson(key, join(dataDir(), `${key}.bin`), value)
}

function remove(key: string): void {
  try {
    secretStore().remove(key, join(dataDir(), `${key}.bin`))
  } catch (error) {
    log.warn('integration_secret_remove_failed', { error: error instanceof Error ? error.message : String(error) })
  }
}

/** The host secret store (`platform/secrets.ts`), which the desktop encrypts with `safeStorage`. */
export const hostIntegrationClients: IntegrationClients = {
  client: (integrationId) => load(clientKey(integrationId), oauthClientSchema),
  saveClient: (integrationId, client) => save(clientKey(integrationId), client),
  removeClient: (integrationId) => remove(clientKey(integrationId)),
}
