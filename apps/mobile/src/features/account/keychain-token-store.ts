import { storedGrantSchema, type StoredGrant, type TokenStore } from '@solus/client-core/oauth-session'
import type { SecretStore } from '../../platform/ports'

/** The keychain entry of the account sign-in. A value of the old session-token form does not parse. */
export const ACCOUNT_GRANT_KEY = 'solus.mobile.account'

/**
 * The mobile `TokenStore` (docs/adr/0001-standard-authentication.md §3.2): the refresh
 * token in the device keychain. `OAuthSession` reads and writes its store at once, and
 * the keychain answers later, so this store keeps the grant in memory and writes it
 * through. Writes run in order, so a clear and a later sign-in cannot land the wrong
 * way round. `read` fills the memory copy before the session reloads it.
 */
export class KeychainTokenStore implements TokenStore {
  private grant: StoredGrant | null = null
  private writes: Promise<void> = Promise.resolve()

  constructor(
    private readonly secrets: SecretStore,
    private readonly onWriteFailed: (error: unknown) => void = () => {},
  ) {}

  /** Reads the keychain once at start. An entry that does not parse is deleted. */
  async read(): Promise<void> {
    const raw = await this.secrets.get(ACCOUNT_GRANT_KEY)
    if (!raw) return
    const parsed = storedGrantSchema.safeParse(parseJson(raw))
    if (parsed.success) this.grant = parsed.data
    else await this.secrets.delete(ACCOUNT_GRANT_KEY)
  }

  load(): StoredGrant | null {
    return this.grant
  }

  save(grant: StoredGrant): void {
    this.grant = grant
    this.write(() => this.secrets.set(ACCOUNT_GRANT_KEY, JSON.stringify(grant)))
  }

  clear(): void {
    this.grant = null
    this.write(() => this.secrets.delete(ACCOUNT_GRANT_KEY))
  }

  /** Resolves when every write so far has reached the keychain. */
  written(): Promise<void> {
    return this.writes
  }

  private write(operation: () => Promise<void>): void {
    this.writes = this.writes.then(operation).catch(this.onWriteFailed)
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
