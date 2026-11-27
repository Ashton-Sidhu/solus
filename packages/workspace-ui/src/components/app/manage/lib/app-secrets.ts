import type { AppSecretState } from '@solus/contracts/apps'

/**
 * The words of the Secrets section (docs/plans/apps.md §4.4, §9.2). A value
 * is write-only: the client knows only whether a secret has one.
 */

/** The line beside the section's title: how many secrets have a value, and where the values are. */
export function secretVaultSummary(secrets: readonly Pick<AppSecretState, 'isSet'>[], hostLabel: string): string {
  const set = secrets.filter((secret) => secret.isSet).length
  return `${set} of ${secrets.length} ${secrets.length === 1 ? 'has' : 'have'} a value · in the secret store on ${hostLabel}`
}

/**
 * The names of the secrets the code reads that have no value, for the
 * warning above the table. Every declared secret is one the code reads, so
 * each one without a value makes the calls that read it fail.
 */
export function missingSecretNames(secrets: readonly Pick<AppSecretState, 'name' | 'isSet'>[]): string[] {
  return secrets.filter((secret) => !secret.isSet).map((secret) => secret.name)
}
