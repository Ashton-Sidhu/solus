import { join } from 'path'
import { z } from 'zod'
import type { GithubDelegatedCredential } from '@solus/contracts/types'
import { createLogger } from '../../logger'
import { dataDir } from '../../platform/paths'
import { secretStore } from '../../platform/secrets'
import { EncryptionUnavailableError } from '../../vault/vault'

/**
 * The GitHub credentials that `solus git-credential` serves from its own process,
 * which has no account access: paired devices' credentials, and a copy of the
 * signed-in machine owner's account login. Only `GitHubCredentials` reads or writes them.
 */

const log = createLogger('main', 'github-delegation-store')

const DELEGATIONS_KEY = 'github-delegations'

const delegationsSchema = z.record(z.string(), z.object({
  accessToken: z.string(),
  login: z.string(),
}))

function delegationsFile(): string {
  return join(dataDir(), 'github-delegations.bin')
}

export function loadDelegation(deviceId: string): GithubDelegatedCredential | null {
  const delegations = secretStore().loadJson(
    DELEGATIONS_KEY,
    delegationsFile(),
    delegationsSchema,
  )
  return delegations?.[deviceId] ?? null
}

export function saveDelegation(deviceId: string, credential: GithubDelegatedCredential): void {
  const store = secretStore()
  if (!store.canSave()) throw new EncryptionUnavailableError()
  const delegations = store.loadJson(
    DELEGATIONS_KEY,
    delegationsFile(),
    delegationsSchema,
  ) ?? {}
  delegations[deviceId] = credential
  store.saveJson(DELEGATIONS_KEY, delegationsFile(), delegations)
}

export function clearDelegation(deviceId: string): void {
  try {
    const store = secretStore()
    const delegations = store.loadJson(
      DELEGATIONS_KEY,
      delegationsFile(),
      delegationsSchema,
    )
    if (!delegations?.[deviceId]) return
    delete delegations[deviceId]
    if (Object.keys(delegations).length === 0) store.remove(DELEGATIONS_KEY, delegationsFile())
    else store.saveJson(DELEGATIONS_KEY, delegationsFile(), delegations)
  } catch (err) {
    log.warn('delegation_file_remove_failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

const OWNER_ACCOUNT_KEY = 'github-owner-account'
const ownerAccountSchema = z.object({ accessToken: z.string().min(1) })

function ownerAccountFile(): string {
  return join(dataDir(), 'github-owner-account.bin')
}

export function loadOwnerAccountToken(): string | null {
  return secretStore().loadJson(OWNER_ACCOUNT_KEY, ownerAccountFile(), ownerAccountSchema)?.accessToken ?? null
}

export function saveOwnerAccountToken(accessToken: string): void {
  const store = secretStore()
  if (!store.canSave()) throw new EncryptionUnavailableError()
  store.saveJson(OWNER_ACCOUNT_KEY, ownerAccountFile(), { accessToken })
}

export function clearOwnerAccountToken(): void {
  try {
    secretStore().remove(OWNER_ACCOUNT_KEY, ownerAccountFile())
  } catch (err) {
    log.warn('owner_account_token_remove_failed', { error: err instanceof Error ? err.message : String(err) })
  }
}
