import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { createLogger } from '../../logger'

const log = createLogger('main', 'github-token-store')

const TOKEN_FILE = join(app.getPath('userData'), 'github-oauth.bin')

/**
 * Persisted GitHub OAuth App user token. No `expiresAt`/`refreshToken`: OAuth
 * App user tokens are non-expiring by default. If we later enable expiring
 * tokens, add those fields plus a refresh path (mirroring google/oauth.ts).
 */
export interface GithubStoredToken {
  accessToken: string
  scope: string
  /** Cached from the first authenticated `/user` call so status() is offline-cheap. */
  login?: string
}

/** Raised when the OS keyring is unavailable; we never write a token in plaintext. */
export class EncryptionUnavailableError extends Error {
  constructor() {
    super('Secure storage is unavailable on this system, so the GitHub token cannot be saved safely.')
    this.name = 'EncryptionUnavailableError'
  }
}

export function loadToken(): GithubStoredToken | null {
  if (!existsSync(TOKEN_FILE)) return null
  try {
    const encrypted = readFileSync(TOKEN_FILE)
    const json = safeStorage.decryptString(encrypted)
    return JSON.parse(json) as GithubStoredToken
  } catch {
    return null
  }
}

export function persistToken(token: GithubStoredToken): void {
  if (!safeStorage.isEncryptionAvailable()) throw new EncryptionUnavailableError()
  const encrypted = safeStorage.encryptString(JSON.stringify(token))
  writeFileSync(TOKEN_FILE, encrypted, { mode: 0o600 })
}

export function clearToken(): void {
  try {
    if (existsSync(TOKEN_FILE)) unlinkSync(TOKEN_FILE)
  } catch (err) {
    log.warn(`Failed to remove token file: ${err}`)
  }
}
