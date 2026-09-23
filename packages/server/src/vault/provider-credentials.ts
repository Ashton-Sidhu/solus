import { accountIntegrationCredential, type IntegrationProvider } from './account-integrations'
import { join } from 'node:path'
import type { z } from 'zod'
import { createLogger } from '../logger'
import { dataDir } from '../platform/paths'
import { secretStore } from '../platform/secrets'
import { isWorkspaceMode } from '../server/workspace-mode'
import { currentCredentialUserId } from './credential-scope'

const log = createLogger('main', 'provider-credentials')

export type ProviderCredentialName = IntegrationProvider

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

export { resetAccountIntegrationsForTests as resetProviderCredentialsForTests } from './account-integrations'

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

/** Account credentials are fetched directly. Refresh tokens never leave the account backend. */
export function usesAccountIntegration(): boolean {
  return isWorkspaceMode() || !!currentCredentialUserId()
}

export async function readProviderCredential<T>(provider: ProviderCredentialName, schema: z.ZodType<T>): Promise<T | null> {
  const userId = currentCredentialUserId()
  if (!userId) return isWorkspaceMode() ? null : readHostCredential(provider, schema)
  const response = await accountIntegrationCredential(userId, provider)
  if (!response) throw new Error('Reconnect to your host to authorize your account connections.')
  if (response.status === 404) return null
  if (!response.ok) throw new Error('Your account connection is unavailable. Open Connections on the account website.')
  return schema.parse(await response.json())
}

export async function writeProviderCredential<T>(provider: ProviderCredentialName, value: T): Promise<void> {
  if (usesAccountIntegration()) throw new Error('Manage this connection on the account website.')
  writeHostCredential(provider, value)
}

export async function clearProviderCredential(provider: ProviderCredentialName): Promise<void> {
  if (usesAccountIntegration()) throw new Error('Disconnect this account on the account website.')
  clearHostCredential(provider)
}
