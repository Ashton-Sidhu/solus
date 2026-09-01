import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { z } from 'zod'
import type { AccountProfile } from '@solus/contracts/account-types'

/**
 * The one place the account session token is persisted. Encrypted with the OS
 * keychain (`safeStorage`) and written 0600; refuses to store anything when the
 * keychain is unavailable rather than falling back to plaintext.
 */

const storedAccountSchema = z.object({
  sessionToken: z.string().min(1),
  profile: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    avatarUrl: z.string().nullable(),
  }),
  cloudOrigin: z.url(),
  signedInAt: z.number(),
  lastVerifiedAt: z.number(),
})

export type StoredAccount = z.infer<typeof storedAccountSchema>

export interface AccountCipher {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export class AccountStore {
  constructor(
    private readonly filePath: string,
    private readonly cipher: AccountCipher,
  ) {}

  canPersist(): boolean {
    return this.cipher.isEncryptionAvailable()
  }

  load(): StoredAccount | null {
    if (!this.canPersist() || !existsSync(this.filePath)) return null
    try {
      const json = this.cipher.decryptString(readFileSync(this.filePath))
      const parsed = storedAccountSchema.safeParse(JSON.parse(json))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  save(account: StoredAccount): void {
    if (!this.canPersist()) throw new Error('account_store_encryption_unavailable')
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, this.cipher.encryptString(JSON.stringify(account)), { mode: 0o600 })
  }

  clear(): void {
    if (existsSync(this.filePath)) unlinkSync(this.filePath)
  }
}

const meResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
})

/** Parses `GET /api/account/me` at the boundary; anything malformed reads as no profile. */
export async function profileFromResponse(response: Response): Promise<AccountProfile | null> {
  const parsed = meResponseSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) return null
  return {
    id: parsed.data.id,
    email: parsed.data.email,
    name: parsed.data.name ?? null,
    avatarUrl: parsed.data.avatarUrl ?? null,
  }
}
