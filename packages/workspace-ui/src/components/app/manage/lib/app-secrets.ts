import type { AppSecretState } from '@solus/contracts/apps'

/**
 * The words of the Secrets section's vault (docs/plans/apps.md §4.4, §9.2).
 * A value is write-only: the client knows only whether a secret has one.
 */

/** The line under the vault's title: where the values are, and how many slots have one. */
export function secretVaultSummary(secrets: readonly Pick<AppSecretState, 'isSet'>[], hostLabel: string): string {
  const set = secrets.filter((secret) => secret.isSet).length
  const count = secrets.length === 1 ? (set === 1 ? '1 of 1 has a value' : 'it has no value yet') : `${set} of ${secrets.length} have a value`
  return `In the secret store on ${hostLabel} · ${count}`
}

/** What an empty slot says: that it has no value, what the secret is for, and what fails without it. */
export function emptySecretNote(secret: Pick<AppSecretState, 'description'>): string {
  const purpose = secret.description.trim()
  return ['No value yet.', purpose && /[.!?]$/.test(purpose) ? purpose : purpose ? `${purpose}.` : '', 'Calls that read it fail until you add one.']
    .filter(Boolean)
    .join(' ')
}
