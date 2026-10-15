import type { TypeSafeKeyStatus } from '@solus/contracts/host-config'
import { typesafeDeliverySchema } from '@solus/contracts/vault'
import { currentPersonKey } from '../vault/acting-scope'
import { credentialLocationOf, TYPESAFE_REF, vault } from '../vault/vault'

/**
 * A person's TypeSafe key (docs/plans/cloud-vault.md §2.5). The vault decides
 * where it is: this host's store for the host's user before the host is linked
 * to their account, the person's account once they are signed in (the owner of a
 * linked host, and every member), and nowhere for a guest. No key is the host's
 * as a whole. The host store keeps the key in the account's shape, `{ key }`.
 */

/** Where the caller's key is and what holds it. Contains no credential value. */
export async function typeSafeKeyStatus(): Promise<TypeSafeKeyStatus> {
  const { location, source } = await typeSafeKey()
  return { location, source }
}

/** Saves or (with null) removes the caller's key on this host. Only where the host keeps it. */
export function setTypeSafeApiKey(apiKey: string | null): void {
  const personKey = currentPersonKey()
  if (apiKey === null) vault().remove(personKey, TYPESAFE_REF)
  else vault().save(personKey, TYPESAFE_REF, typesafeDeliverySchema.parse({ key: apiKey.trim() }))
}

/** The acting person's key and where it is. Never return `apiKey` to a client. */
export async function typeSafeKey(): Promise<TypeSafeKeyStatus & { apiKey?: string }> {
  const personKey = currentPersonKey()
  const location = credentialLocationOf(personKey).kind
  const saved = await vault().read(personKey, TYPESAFE_REF, typesafeDeliverySchema)
  if (saved) return { location, source: 'saved', apiKey: saved.key }
  // The launching shell's key is a machine credential, like `gh`: only where the
  // host keeps the person's logins, never a member's.
  const fromShell = location === 'host' ? process.env.TYPESAFE_API_KEY?.trim() : undefined
  return fromShell ? { location, source: 'environment', apiKey: fromShell } : { location, source: null }
}
