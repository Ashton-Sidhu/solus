import { join } from 'path'
import { z } from 'zod'
import type { GithubDelegatedCredential } from '@solus/contracts/types'
import { createLogger } from '../../logger'
import { dataDir } from '../../platform/paths'
import { secretStore } from '../../platform/secrets'
import { EncryptionUnavailableError } from './token-store'

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
