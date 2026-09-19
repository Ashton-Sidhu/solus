import { join } from 'node:path'
import type { z } from 'zod'
import { HOST_OWNER_USER_ID } from '@solus/contracts/sharing'
import { createLogger } from '../logger'
import { dataDir } from '../platform/paths'
import { secretStore } from '../platform/secrets'
import { isWorkspaceMode } from '../server/workspace-mode'
import type { CredentialMaterial, VaultProvider } from '../server/uplink/runner-protocol'
import { credentialExpiresAt, PROVIDER_CREDENTIAL_FILE } from './credential-material'
import { currentCredentialUserId } from './credential-scope'
import type { VaultClient } from './vault-client'

const log = createLogger('main', 'provider-credentials')

/**
 * Where a GitHub, Google, or Atlassian credential lives, chosen by where this
 * process runs and who is asking (docs/plans/cloud-service-model.md §22):
 *
 * - The workspace service keeps one row per person in the vault; a call with no
 *   scoped person reads nothing and cannot write.
 * - A runner holding a grant leases the scoped member's row and keeps it in
 *   memory only; a refreshed token goes back under the version it leased.
 * - Everything else — a signed-out host, the host's own owner, headless work
 *   nobody asked for — is the host's own secret store, as before.
 *
 * The stored value is the provider store's own JSON, so the vault holds one
 * shape for every provider: `{ files: { 'credential.json': <that JSON> } }`.
 */

export type ProviderCredentialName = Extract<VaultProvider, 'github' | 'google' | 'atlassian'>

/** Raised when the OS keyring is unavailable; we never write a token in
 *  plaintext. Shared by every provider that stores a credential. */
export class EncryptionUnavailableError extends Error {
  constructor() {
    super('Secure storage is unavailable on this system, so the token cannot be saved safely.')
    this.name = 'EncryptionUnavailableError'
  }
}

const HOST_SECRETS = {
  github: { key: 'github-oauth', file: 'github-oauth.bin' },
  google: { key: 'google-oauth', file: 'google-oauth.bin' },
  atlassian: { key: 'atlassian-oauth', file: 'atlassian-oauth.bin' },
} satisfies Record<ProviderCredentialName, { key: string; file: string }>

/** A leased credential stands this long before the runner asks the vault again. */
const LEASE_TTL_MS = 5 * 60_000

interface LeasedProviderCredential {
  version: number
  material: CredentialMaterial
  leasedAt: number
}

let vault: VaultClient | null = null
const leased = new Map<string, LeasedProviderCredential>()

/** On a runner: members' connections are leased from the organization's vault while the runner holds a grant. */
export function useProviderVault(client: VaultClient): void {
  vault = client
  client.onGrant((info) => {
    if (!info) leased.clear()
  })
}

/** Tests only. */
export function resetProviderCredentialsForTests(): void {
  vault = null
  leased.clear()
}

// ── The host's own store ────────────────────────────────────────────────────

/** The host's own credential, read from the secret store directly: what a signed-out host and its owner use, and what `solus git-credential` serves. */
export function readHostCredential<T>(provider: ProviderCredentialName, schema: z.ZodType<T>): T | null {
  const secret = HOST_SECRETS[provider]
  return secretStore().loadJson(secret.key, join(dataDir(), secret.file), schema)
}

function writeHostCredential<T>(provider: ProviderCredentialName, value: T): void {
  const store = secretStore()
  if (!store.canSave()) throw new EncryptionUnavailableError()
  const secret = HOST_SECRETS[provider]
  store.saveJson(secret.key, join(dataDir(), secret.file), value)
}

function clearHostCredential(provider: ProviderCredentialName): void {
  const secret = HOST_SECRETS[provider]
  try {
    secretStore().remove(secret.key, join(dataDir(), secret.file))
  } catch (err) {
    log.warn('token_file_remove_failed', { provider, error: err instanceof Error ? err.message : String(err) })
  }
}

// ── The material ────────────────────────────────────────────────────────────

function materialOf<T>(value: T): CredentialMaterial {
  return { files: { [PROVIDER_CREDENTIAL_FILE]: JSON.stringify(value) } }
}

function valueOf<T>(provider: ProviderCredentialName, material: CredentialMaterial, schema: z.ZodType<T>): T | null {
  const text = material.files?.[PROVIDER_CREDENTIAL_FILE]
  if (!text) return null
  try {
    const parsed = schema.safeParse(JSON.parse(text))
    if (parsed.success) return parsed.data
  } catch {}
  log.warn('vault_provider_credential_unreadable', { provider })
  return null
}

// ── Who is asking ───────────────────────────────────────────────────────────

type CredentialPlace =
  | { kind: 'service'; userId: string | null }
  | { kind: 'leased'; userId: string; vault: VaultClient }
  | { kind: 'host' }

function placeFor(): CredentialPlace {
  const userId = currentCredentialUserId()
  if (isWorkspaceMode()) return { kind: 'service', userId: userId === HOST_OWNER_USER_ID ? null : userId }
  if (userId && userId !== HOST_OWNER_USER_ID && vault?.currentGrant()) return { kind: 'leased', userId, vault }
  return { kind: 'host' }
}

function leaseKey(userId: string, provider: ProviderCredentialName): string {
  return `${userId}\n${provider}`
}

// ── Reading ─────────────────────────────────────────────────────────────────

export async function readProviderCredential<T>(provider: ProviderCredentialName, schema: z.ZodType<T>): Promise<T | null> {
  const place = placeFor()
  switch (place.kind) {
    case 'host':
      return readHostCredential(provider, schema)
    case 'service': {
      if (!place.userId) return null
      const { readCredential } = await import('./vault')
      const stored = await readCredential(place.userId, provider)
      return stored ? valueOf(provider, stored.material, schema) : null
    }
    case 'leased': {
      const held = await leaseProviderCredential(place.vault, place.userId, provider)
      return held ? valueOf(provider, held.material, schema) : null
    }
  }
}

/**
 * The member's credential as the vault holds it, asked for again once the lease
 * is old. `no_credential` drops the copy; a service that cannot be asked leaves
 * an earlier copy standing so the call still runs.
 */
async function leaseProviderCredential(client: VaultClient, userId: string, provider: ProviderCredentialName): Promise<LeasedProviderCredential | null> {
  const key = leaseKey(userId, provider)
  const held = leased.get(key)
  const now = Date.now()
  if (held && now - held.leasedAt < LEASE_TTL_MS) return held
  const outcome = await client.lease(userId, provider)
  if (outcome.kind === 'no_credential') {
    leased.delete(key)
    return null
  }
  if (outcome.kind === 'unavailable') return held ?? null
  const entry: LeasedProviderCredential = { version: outcome.lease.version, material: outcome.lease.material, leasedAt: now }
  leased.set(key, entry)
  log.info('provider_credential_leased', { userId, provider, version: entry.version })
  return entry
}

// ── Writing ─────────────────────────────────────────────────────────────────

export async function writeProviderCredential<T>(provider: ProviderCredentialName, value: T): Promise<void> {
  const place = placeFor()
  switch (place.kind) {
    case 'host':
      writeHostCredential(provider, value)
      return
    case 'service': {
      if (!place.userId) throw new Error(`No signed-in person to store the ${provider} connection for.`)
      const { putCredential } = await import('./vault')
      const material = materialOf(value)
      await putCredential(place.userId, provider, 'login', material, credentialExpiresAt(provider, material))
      return
    }
    case 'leased':
      await writeBackLeased(place.vault, place.userId, provider, materialOf(value))
      return
  }
}

/** A refreshed token goes back under the version leased; another runner's newer version drops this copy. Nothing is written to disk. */
async function writeBackLeased(client: VaultClient, userId: string, provider: ProviderCredentialName, material: CredentialMaterial): Promise<void> {
  const key = leaseKey(userId, provider)
  const held = leased.get(key)
  if (!held) {
    log.warn('provider_credential_write_without_lease', { userId, provider })
    return
  }
  const outcome = await client.writeBack(userId, provider, held.version, material, credentialExpiresAt(provider, material))
  if (outcome.kind === 'version_conflict') {
    leased.delete(key)
    log.info('provider_credential_write_back_conflict', { userId, provider, version: held.version })
    return
  }
  // The service could not be asked: the refreshed token still serves this process until the next lease.
  held.material = material
  if (outcome.kind === 'ok') held.version = outcome.version
}

// ── Clearing ────────────────────────────────────────────────────────────────

/** Forgets the credential where this process keeps it: a runner forgets its copy only; the person's row is theirs to disconnect on the service. */
export async function clearProviderCredential(provider: ProviderCredentialName): Promise<void> {
  const place = placeFor()
  switch (place.kind) {
    case 'host':
      clearHostCredential(provider)
      return
    case 'service': {
      if (!place.userId) return
      const { deleteCredential } = await import('./vault')
      await deleteCredential(place.userId, provider)
      return
    }
    case 'leased':
      leased.delete(leaseKey(place.userId, provider))
      return
  }
}
