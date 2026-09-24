import type { AccountProfile } from '@solus/contracts/account-types'

/** The letter an avatar without a picture shows: the name's, else the email's. */
export function accountInitial(profile: AccountProfile): string {
  const source = profile.name?.trim() || profile.email.trim()
  return source.charAt(0).toUpperCase() || '?'
}

/** The account website pages the account menu links out to. */
export type ConsolePage = 'account' | 'organizations'

export function consolePageUrl(consoleUrl: string, page: ConsolePage): string {
  return new URL(`/${page}`, consoleUrl).toString()
}
