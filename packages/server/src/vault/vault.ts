import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDatabase } from '../db/database'
import { createLogger } from '../logger'
import { credentialMaterialSchema, type CredentialMaterial, type VaultProvider } from '../server/uplink/runner-protocol'
import { credentialLocks, credentialVault, organizationMembers } from './schema'

const log = createLogger('main', 'vault')

/**
 * The credential vault (docs/plans/cloud-service-model.md §5): a person connects
 * Claude or Codex once on the workspace service; every runner leases that
 * credential for that person's turns only. The material is the provider's own
 * file set, encrypted with AES-256-GCM under the service key before it is
 * stored. A write back names the version it leased, so two runners that refresh
 * the same login cannot overwrite each other blind; the refresh lock keeps them
 * from trying at the same time.
 */

export const VAULT_KEY_ENV = 'SOLUS_VAULT_KEY'
export const VAULT_NOT_CONFIGURED_CODE = 'VAULT_NOT_CONFIGURED'

export class VaultNotConfiguredError extends Error {
  readonly code = VAULT_NOT_CONFIGURED_CODE

  constructor() {
    super('The workspace service has no credential vault key; provider seats are not available here.')
    this.name = 'VaultNotConfiguredError'
  }
}

export type CredentialMethod = 'login' | 'token'

export interface StoredCredential {
  version: number
  method: CredentialMethod
  material: CredentialMaterial
  expiresAt: number | null
}

/** The row without its material: what a status answer needs. */
export interface CredentialInfo {
  version: number
  method: CredentialMethod
  expiresAt: number | null
  connectedAt: number
}

// ── The key ─────────────────────────────────────────────────────────────────

let key: Buffer | null | undefined

function readKey(): Buffer | null {
  if (key !== undefined) return key
  const encoded = process.env[VAULT_KEY_ENV]?.trim()
  if (!encoded) {
    key = null
    log.warn('vault_key_missing', { env: VAULT_KEY_ENV })
    return key
  }
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.length !== 32) throw new Error(`${VAULT_KEY_ENV} must be 32 bytes, base64-encoded.`)
  key = decoded
  return key
}

export function vaultConfigured(): boolean {
  return readKey() !== null
}

function requireKey(): Buffer {
  const found = readKey()
  if (!found) throw new VaultNotConfiguredError()
  return found
}

/** Tests only: forget the cached key so the next read sees the test's environment. */
export function resetVaultForTests(): void {
  key = undefined
}

// ── The cipher ──────────────────────────────────────────────────────────────

const CIPHER_VERSION = 'v1'

function encrypt(material: CredentialMaterial): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', requireKey(), iv)
  const plaintext = Buffer.from(JSON.stringify(material), 'utf8')
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  return `${CIPHER_VERSION}.${iv.toString('base64')}.${body.toString('base64')}`
}

function decrypt(ciphertext: string): CredentialMaterial {
  const [version, ivText, bodyText] = ciphertext.split('.')
  if (version !== CIPHER_VERSION || !ivText || !bodyText) throw new Error('The stored credential is not in a form this vault reads.')
  const body = Buffer.from(bodyText, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', requireKey(), Buffer.from(ivText, 'base64'))
  decipher.setAuthTag(body.subarray(body.length - 16))
  const plaintext = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()])
  return credentialMaterialSchema.parse(JSON.parse(plaintext.toString('utf8')))
}

export { credentialExpiresAt } from './credential-material'

// ── Credentials ─────────────────────────────────────────────────────────────

const methodSchema = z.enum(['login', 'token'])
const credentialRowSchema = z.object({
  version: z.number(),
  method: methodSchema,
  ciphertext: z.string(),
  expires_at: z.number().nullable(),
  connected_at: z.number(),
})
const versionRowSchema = z.object({ version: z.number() })

/** Stores a person's credential for a provider; a replacement advances the version. Answers the version stored. */
export async function putCredential(userId: string, provider: VaultProvider, method: CredentialMethod, material: CredentialMaterial, expiresAt: number | null): Promise<number> {
  const ciphertext = encrypt(material)
  const now = Date.now()
  const row = versionRowSchema.parse(await getDatabase().get(sql`
    INSERT INTO ${credentialVault} (user_id, provider, method, ciphertext, version, expires_at, connected_at, updated_at)
    VALUES (${userId}, ${provider}, ${method}, ${ciphertext}, 1, ${expiresAt}, ${now}, ${now})
    ON CONFLICT (user_id, provider) DO UPDATE SET
      method = excluded.method,
      ciphertext = excluded.ciphertext,
      version = ${credentialVault}.version + 1,
      expires_at = excluded.expires_at,
      connected_at = excluded.connected_at,
      updated_at = excluded.updated_at
    RETURNING version
  `))
  log.info('vault_credential_stored', { userId, provider, method, version: row.version })
  return row.version
}

export async function readCredential(userId: string, provider: VaultProvider): Promise<StoredCredential | null> {
  requireKey()
  const row = credentialRowSchema.nullish().parse(await getDatabase().get(sql`
    SELECT version, method, ciphertext, expires_at, connected_at FROM ${credentialVault}
    WHERE user_id = ${userId} AND provider = ${provider}
  `))
  if (!row) return null
  return { version: row.version, method: row.method, material: decrypt(row.ciphertext), expiresAt: row.expires_at }
}

/** The row's facts without decrypting anything: for a status answer. */
export async function readCredentialInfo(userId: string, provider: VaultProvider): Promise<CredentialInfo | null> {
  const row = credentialRowSchema.nullish().parse(await getDatabase().get(sql`
    SELECT version, method, ciphertext, expires_at, connected_at FROM ${credentialVault}
    WHERE user_id = ${userId} AND provider = ${provider}
  `))
  if (!row) return null
  return { version: row.version, method: row.method, expiresAt: row.expires_at, connectedAt: row.connected_at }
}

/** Deletes the credential and any lock on it. Answers whether there was one. */
export async function deleteCredential(userId: string, provider: VaultProvider): Promise<boolean> {
  const database = getDatabase()
  const deleted = await database.run(sql`DELETE FROM ${credentialVault} WHERE user_id = ${userId} AND provider = ${provider}`)
  await database.run(sql`DELETE FROM ${credentialLocks} WHERE user_id = ${userId} AND provider = ${provider}`)
  if (deleted.changes > 0) log.info('vault_credential_deleted', { userId, provider })
  return deleted.changes > 0
}

export type WriteBackOutcome =
  | { kind: 'ok'; version: number }
  | { kind: 'version_conflict' }
  | { kind: 'no_credential' }

/**
 * A runner refreshed the credential it leased: the write lands only when the
 * vault still holds the version it leased. A newer version means another runner
 * refreshed first, and the caller re-leases instead of overwriting it.
 */
export async function writeBack(userId: string, provider: VaultProvider, baseVersion: number, material: CredentialMaterial, expiresAt: number | null): Promise<WriteBackOutcome> {
  const ciphertext = encrypt(material)
  const database = getDatabase()
  const row = versionRowSchema.nullish().parse(await database.get(sql`
    UPDATE ${credentialVault}
    SET ciphertext = ${ciphertext}, version = ${baseVersion + 1}, expires_at = ${expiresAt}, updated_at = ${Date.now()}
    WHERE user_id = ${userId} AND provider = ${provider} AND version = ${baseVersion}
    RETURNING version
  `))
  if (row) {
    log.info('vault_credential_written_back', { userId, provider, version: row.version })
    return { kind: 'ok', version: row.version }
  }
  const current = await readCredentialInfo(userId, provider)
  if (!current) return { kind: 'no_credential' }
  log.info('vault_write_back_conflict', { userId, provider, baseVersion, version: current.version })
  return { kind: 'version_conflict' }
}

// ── The refresh lock ────────────────────────────────────────────────────────

const lockRowSchema = z.object({ host_id: z.string(), expires_at: z.number() })

/**
 * At most one runner refreshes a credential at a time. The lock is taken when
 * none is held, when the held one has expired, or when the same runner asks
 * again; otherwise the holder's expiry is answered so the caller knows how long
 * to wait. One statement, so two runners asking at once cannot both win.
 */
export async function acquireLock(userId: string, provider: VaultProvider, hostId: string, ttlMs: number): Promise<{ acquired: boolean; expiresAt: number }> {
  const now = Date.now()
  const expiresAt = now + ttlMs
  const database = getDatabase()
  const won = lockRowSchema.nullish().parse(await database.get(sql`
    INSERT INTO ${credentialLocks} (user_id, provider, host_id, expires_at)
    VALUES (${userId}, ${provider}, ${hostId}, ${expiresAt})
    ON CONFLICT (user_id, provider) DO UPDATE SET host_id = excluded.host_id, expires_at = excluded.expires_at
    WHERE ${credentialLocks}.expires_at <= ${now} OR ${credentialLocks}.host_id = excluded.host_id
    RETURNING host_id, expires_at
  `))
  if (won) return { acquired: true, expiresAt: won.expires_at }
  const holder = lockRowSchema.nullish().parse(await database.get(sql`
    SELECT host_id, expires_at FROM ${credentialLocks} WHERE user_id = ${userId} AND provider = ${provider}
  `))
  // The holder released between the two statements: the caller asks again and wins.
  return { acquired: false, expiresAt: holder?.expires_at ?? now }
}

/** Releases the lock if this runner holds it; another runner's lock is left alone. */
export async function releaseLock(userId: string, provider: VaultProvider, hostId: string): Promise<boolean> {
  const result = await getDatabase().run(sql`
    DELETE FROM ${credentialLocks} WHERE user_id = ${userId} AND provider = ${provider} AND host_id = ${hostId}
  `)
  return result.changes > 0
}

// ── Organization members ────────────────────────────────────────────────────

/** A member's socket was admitted: the organization may lease their credential from now on. */
export async function touchOrganizationMember(organizationId: string, userId: string, displayName: string | null): Promise<void> {
  await getDatabase().run(sql`
    INSERT INTO ${organizationMembers} (organization_id, user_id, display_name, last_seen_at)
    VALUES (${organizationId}, ${userId}, ${displayName}, ${Date.now()})
    ON CONFLICT (organization_id, user_id) DO UPDATE SET display_name = excluded.display_name, last_seen_at = excluded.last_seen_at
  `)
}

export async function isOrganizationMember(organizationId: string, userId: string): Promise<boolean> {
  const row = await getDatabase().get(sql`
    SELECT user_id FROM ${organizationMembers} WHERE organization_id = ${organizationId} AND user_id = ${userId}
  `)
  return row !== undefined
}
