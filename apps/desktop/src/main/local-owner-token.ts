import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { createLogger } from '@solus/server/logger'
import type { AccountCipher } from './account/account-store'

const log = createLogger('main', 'local-owner-token')

/** A local token older than this is signed again with the same device id. */
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export interface LocalOwnerTokenDeps {
  /** The token, encrypted with the OS keychain (`safeStorage`). */
  file: string
  /** The plaintext file of earlier versions: removed unread. */
  legacyFile: string
  cipher: AccountCipher
  /** A new host session token for this window, labelled as this machine. */
  issue: () => string
  /** The token's issue time, or null when this host does not accept it. */
  issuedAt: (token: string) => number | null
  refresh: (token: string) => string | null
  now: () => number
}

/**
 * The window's credential for its own host (docs/adr/0001-standard-authentication.md
 * stage 6). The window and the host run on one machine, in one app, so the window is
 * this machine's owner (`local-owner`) whether or not anyone is signed in: it works
 * offline and before the host is linked. It is a host session token, and it carries
 * no account. Account access comes only from main's own sign-in, which presents its
 * token to the host (`account/local-host-client.ts`).
 *
 * The token is kept encrypted with the keychain, so the window keeps one device id
 * across restarts. With no keychain it is kept in memory only, never in plaintext.
 */
export class LocalOwnerToken {
  private token: string | null = null

  constructor(private readonly deps: LocalOwnerTokenDeps) {
    if (existsSync(deps.legacyFile)) rmSync(deps.legacyFile, { force: true })
  }

  /** A token this host accepts now: the one held, then the one stored, then a new one. */
  current(): string {
    const held = this.token ? this.accepted(this.token) : null
    if (held) return held
    const stored = this.load()
    const accepted = stored ? this.accepted(stored) : null
    if (accepted) return accepted
    return this.keep(this.deps.issue())
  }

  /** The token, signed again when it is old; null when the host does not accept it. */
  private accepted(token: string): string | null {
    const issuedAt = this.deps.issuedAt(token)
    if (issuedAt === null) return null
    if (this.deps.now() - issuedAt <= REFRESH_AFTER_MS) {
      this.token = token
      return token
    }
    return this.keep(this.deps.refresh(token) ?? token)
  }

  private keep(token: string): string {
    this.token = token
    if (!this.deps.cipher.isEncryptionAvailable()) return token
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true })
      writeFileSync(this.deps.file, this.deps.cipher.encryptString(token), { mode: 0o600 })
    } catch (error) {
      log.warn('local_session_token_persist_failed', { error: error instanceof Error ? error.message : String(error) })
    }
    return token
  }

  private load(): string | null {
    if (!this.deps.cipher.isEncryptionAvailable() || !existsSync(this.deps.file)) return null
    try {
      return this.deps.cipher.decryptString(readFileSync(this.deps.file))
    } catch {
      return null
    }
  }
}
