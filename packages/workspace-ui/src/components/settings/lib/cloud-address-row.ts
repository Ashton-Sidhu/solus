import type { AccountState } from '@solus/contracts/account-types'
import { cloudAddressChangeRefusalText, cloudUnreachableText, type CloudAddressState } from '@solus/contracts/cloud-address'

/** What the Solus Cloud address row shows for one account state (docs/solus-cloud-address.md). */
export interface CloudAddressRow {
  /** False while a sign-in is held or runs, and while the environment chooses the address. */
  isEditable: boolean
  /** The one line that says why the address cannot change; null while it can. */
  lockNote: string | null
  /** Why the last sign-in did not reach the address; null when it did, or none ran. */
  signInError: string | null
}

export function cloudAddressRow(account: AccountState, address: CloudAddressState): CloudAddressRow {
  const signInError = account.kind === 'invalid' && account.reason === 'unreachable' ? cloudUnreachableText(address.origin) : null
  if (address.source === 'environment') return { isEditable: false, lockNote: cloudAddressChangeRefusalText('environment'), signInError }
  if (account.kind === 'signed-in') return { isEditable: false, lockNote: cloudAddressChangeRefusalText('signed-in'), signInError }
  if (account.kind === 'signing-in') return { isEditable: false, lockNote: 'Finish or cancel the sign-in to change the address.', signInError }
  return { isEditable: true, lockNote: null, signInError }
}
