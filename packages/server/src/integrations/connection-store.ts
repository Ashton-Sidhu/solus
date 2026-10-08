import { join } from 'node:path'
import { z } from 'zod'
import type { IntegrationConnection, IntegrationConnectionStatus } from '@solus/contracts/integration-types'
import { getDb } from '../db'
import { createLogger } from '../logger'
import { dataDir } from '../platform/paths'
import { secretStore } from '../platform/secrets'
import { EncryptionUnavailableError } from '../vault/provider-credentials'

/**
 * Connections (docs/plans/mcp-integrations.md §3.3, §4.1): one person's sign-in
 * to one integration. The row holds the status and the identity the server
 * reported; the token is in the host secret store, keyed by integration and
 * person, and never reaches this table or a client.
 *
 * `credentialUserId` is the acting scope's: null for the host owner, else the
 * person's user key. The table writes the owner as `''`, because SQLite treats
 * NULLs in a composite primary key as distinct.
 */

const log = createLogger('integrations', 'connection-store.ts')

const HOST_OWNER_ROW = ''

const connectionInfoSchema = z.object({
  displayName: z.string().optional(),
  email: z.string().optional(),
  avatarUrl: z.string().optional(),
})
type ConnectionInfo = z.infer<typeof connectionInfoSchema>

const connectionRowSchema = z.object({
  integration_id: z.string(),
  user_id: z.string().nullable(),
  status: z.enum(['connected', 'needs-sign-in', 'error']),
  label: z.string().nullable(),
  info: z.string().nullable(),
  error: z.string().nullable(),
  updated_at: z.string(),
})
type ConnectionRow = z.infer<typeof connectionRowSchema>

const COLUMNS = 'integration_id, user_id, status, label, info, error, updated_at'

export interface ConnectionWrite {
  status: IntegrationConnectionStatus
  label?: string | null
  info?: ConnectionInfo | null
  error?: string | null
}

function rowUser(credentialUserId: string | null): string {
  return credentialUserId ?? HOST_OWNER_ROW
}

function connectionFromRow(row: ConnectionRow): IntegrationConnection {
  const info = row.info ? connectionInfoSchema.safeParse(JSON.parse(row.info)) : null
  return {
    integrationId: row.integration_id,
    status: row.status,
    label: row.label,
    info: info?.success ? info.data : null,
    error: row.error,
    updatedAt: row.updated_at,
  }
}

export class IntegrationConnectionStore {
  list(credentialUserId: string | null): IntegrationConnection[] {
    const rows = getDb().prepare(`SELECT ${COLUMNS} FROM integration_connection WHERE user_id = ? ORDER BY integration_id`).all(rowUser(credentialUserId))
    return connectionRowSchema.array().parse(rows).map(connectionFromRow)
  }

  get(integrationId: string, credentialUserId: string | null): IntegrationConnection | null {
    const row = getDb().prepare(`SELECT ${COLUMNS} FROM integration_connection WHERE integration_id = ? AND user_id = ?`).get(integrationId, rowUser(credentialUserId))
    return row ? connectionFromRow(connectionRowSchema.parse(row)) : null
  }

  /** Writes the status; a field left out keeps its stored value. Returns the row as the person reads it. */
  upsert(integrationId: string, credentialUserId: string | null, write: ConnectionWrite): IntegrationConnection {
    const existing = this.get(integrationId, credentialUserId)
    const label = write.label === undefined ? existing?.label ?? null : write.label
    const info = write.info === undefined ? existing?.info ?? null : write.info
    const error = write.error === undefined ? existing?.error ?? null : write.error
    getDb().prepare(`
      INSERT INTO integration_connection (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (integration_id, user_id) DO UPDATE SET status = excluded.status, label = excluded.label,
        info = excluded.info, error = excluded.error, updated_at = excluded.updated_at
    `).run(integrationId, rowUser(credentialUserId), write.status, label, info ? JSON.stringify(info) : null, error, new Date().toISOString())
    const saved = this.get(integrationId, credentialUserId)
    if (!saved) throw new Error('The connection could not be saved.')
    return saved
  }

  remove(integrationId: string, credentialUserId: string | null): boolean {
    return Number(getDb().prepare('DELETE FROM integration_connection WHERE integration_id = ? AND user_id = ?').run(integrationId, rowUser(credentialUserId)).changes) > 0
  }

  /** Removes every person's row for an integration; returns whose rows they were, so their tokens can go too. */
  removeAllFor(integrationId: string): Array<string | null> {
    const users = z.object({ user_id: z.string().nullable() }).array()
      .parse(getDb().prepare('SELECT user_id FROM integration_connection WHERE integration_id = ?').all(integrationId))
      .map((row) => (row.user_id === HOST_OWNER_ROW || row.user_id === null ? null : row.user_id))
    getDb().prepare('DELETE FROM integration_connection WHERE integration_id = ?').run(integrationId)
    return users
  }
}

// ── Secrets ─────────────────────────────────────────────────────────────────

/**
 * One person's credential for one integration. An OAuth token, or a pasted key
 * (`tokenType: 'api-key'`). `expiresAt` is epoch milliseconds. `clientId` names
 * the client that issued an OAuth token, for its refresh.
 */
export const integrationTokenSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().optional(),
  tokenType: z.string().min(1),
  scope: z.string().optional(),
  clientId: z.string().min(1).optional(),
})
export type IntegrationToken = z.infer<typeof integrationTokenSchema>

/**
 * The host's OAuth client for one integration: registered by dynamic client
 * registration (with the redirect addresses it was registered for), or a secret
 * an administrator saved for `auth.oauth.clientId`.
 */
export const integrationClientSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  tokenEndpointAuthMethod: z.enum(['none', 'client_secret_post', 'client_secret_basic']).optional(),
  redirectUris: z.array(z.string()).optional(),
})
export type IntegrationClient = z.infer<typeof integrationClientSchema>

/** Where integration secrets are kept; a test passes its own. */
export interface IntegrationSecrets {
  token(integrationId: string, credentialUserId: string | null): IntegrationToken | null
  /** `EncryptionUnavailableError` when the store cannot save safely. */
  saveToken(integrationId: string, credentialUserId: string | null, token: IntegrationToken): void
  removeToken(integrationId: string, credentialUserId: string | null): void
  client(integrationId: string): IntegrationClient | null
  saveClient(integrationId: string, client: IntegrationClient): void
  removeClient(integrationId: string): void
}

/** `integration-token-<integrationId>-<user or host>`; a user key is encoded so it is a safe file name. */
function tokenKey(integrationId: string, credentialUserId: string | null): string {
  const user = credentialUserId === null ? 'host' : Buffer.from(credentialUserId).toString('base64url')
  return `integration-token-${integrationId}-${user}`
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
export const hostIntegrationSecrets: IntegrationSecrets = {
  token: (integrationId, credentialUserId) => load(tokenKey(integrationId, credentialUserId), integrationTokenSchema),
  saveToken: (integrationId, credentialUserId, token) => save(tokenKey(integrationId, credentialUserId), token),
  removeToken: (integrationId, credentialUserId) => remove(tokenKey(integrationId, credentialUserId)),
  client: (integrationId) => load(clientKey(integrationId), integrationClientSchema),
  saveClient: (integrationId, client) => save(clientKey(integrationId), client),
  removeClient: (integrationId) => remove(clientKey(integrationId)),
}
