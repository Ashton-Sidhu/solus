import { join } from 'path'
import { z } from 'zod'
import { createLogger } from '../logger'
import { dataDir } from '../platform/paths'
import { secretStore } from '../platform/secrets'
import { EncryptionUnavailableError } from '../providers/github/token-store'

const log = createLogger('main', 'cloudflare-token-store')

export const TOKEN_KEY = 'cloudflare-api-token'

export interface CloudflareStoredToken {
  apiToken: string
  accountId: string
  accountName?: string
  expiresOn?: number
}

const cloudflareStoredTokenSchema = z.object({
  apiToken: z.string(),
  accountId: z.string(),
  accountName: z.string().optional(),
  expiresOn: z.number().optional(),
})

function tokenFile(): string {
  return join(dataDir(), 'cloudflare-api-token.bin')
}

export function loadToken(): CloudflareStoredToken | null {
  return secretStore().loadJson(TOKEN_KEY, tokenFile(), cloudflareStoredTokenSchema)
}

export function persistToken(token: CloudflareStoredToken): void {
  const store = secretStore()
  if (!store.canSave()) throw new EncryptionUnavailableError()
  store.saveJson(TOKEN_KEY, tokenFile(), token)
}

export function clearToken(): void {
  try {
    secretStore().remove(TOKEN_KEY, tokenFile())
  } catch (err) {
    log.warn('token_file_remove_failed', { error: err instanceof Error ? err.message : String(err) })
  }
}
