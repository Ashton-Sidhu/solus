import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { storedGrantSchema, type StoredGrant, type TokenStore } from '@solus/client-core/oauth-session'

/**
 * The desktop's `TokenStore` (docs/adr/0001-standard-authentication.md §3.2): the one
 * place the refresh token is persisted. Encrypted with the OS keychain
 * (`safeStorage`) and written 0600; refuses to store anything when the keychain is
 * unavailable rather than falling back to plaintext. A file of the old session-token
 * form does not parse, so that install reads as signed out and signs in again.
 */

export interface AccountCipher {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export class AccountStore implements TokenStore {
  constructor(
    private readonly filePath: string,
    private readonly cipher: AccountCipher,
  ) {}

  canPersist(): boolean {
    return this.cipher.isEncryptionAvailable()
  }

  load(): StoredGrant | null {
    if (!this.canPersist() || !existsSync(this.filePath)) return null
    try {
      const json = this.cipher.decryptString(readFileSync(this.filePath))
      const parsed = storedGrantSchema.safeParse(JSON.parse(json))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  save(grant: StoredGrant): void {
    if (!this.canPersist()) throw new Error('account_store_encryption_unavailable')
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, this.cipher.encryptString(JSON.stringify(grant)), { mode: 0o600 })
  }

  clear(): void {
    if (existsSync(this.filePath)) unlinkSync(this.filePath)
  }
}
