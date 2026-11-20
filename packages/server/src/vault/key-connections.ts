import { z } from 'zod'
import { typesafeDeliverySchema } from '@solus/contracts/vault'
import { vaultKeyRefSchema, vaultKeySaveSchema, type VaultKeyRef, type VaultKeySave, type VaultKeyStatus } from '@solus/contracts/vault-keys'
import { currentPersonKey } from './acting-scope'
import { credentialLocationOf, vault, type Vault } from './vault'

/** Credential changes for an unlinked host. Account writes belong to the client. */
export class KeyConnections {
  constructor(private readonly credentials: Vault = vault(), private readonly fetcher: typeof fetch = fetch) {}

  async status(input: VaultKeyRef): Promise<VaultKeyStatus> {
    const ref = vaultKeyRefSchema.parse(input)
    const personKey = currentPersonKey()
    const location = credentialLocationOf(personKey)
    if (location.kind === 'account') return { kind: 'account' }
    if (location.kind === 'none') return { kind: 'unavailable' }
    const saved = await this.credentials.read(personKey, ref, typesafeDeliverySchema)
    return { kind: 'host', connected: saved !== null }
  }

  async save(input: VaultKeySave): Promise<void> {
    const { ref, key } = vaultKeySaveSchema.parse(input)
    const personKey = currentPersonKey()
    if (credentialLocationOf(personKey).kind !== 'host')
      throw new Error('Save this connection in your Solus account.')
    if (ref.kind === 'provider') {
      // A read-only probe checks the key before it replaces a working connection.
      // The endpoint is fixed and a redirect must never receive the key.
      const response = await this.fetcher('https://api.linear.app/graphql', {
        method: 'POST',
        headers: { authorization: key, 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'query { viewer { id } }' }),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000)
      })
      if (!response.ok) throw new Error(`Linear could not verify this key (${response.status}).`)
      const result = z.object({
        data: z.object({ viewer: z.object({ id: z.string().min(1) }) }).nullish(),
        errors: z.array(z.object({ message: z.string() })).optional()
      }).parse(await response.json())
      if (result.errors?.length || !result.data?.viewer)
        throw new Error('Linear could not verify this key. Check its access and try again.')
    }
    // The vault checks ownership again after the network request.
    this.credentials.save(personKey, ref, { key })
  }

  disconnect(input: VaultKeyRef): void {
    this.credentials.remove(currentPersonKey(), vaultKeyRefSchema.parse(input))
  }
}
