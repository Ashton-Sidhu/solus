import type { AccountState } from '@solus/contracts/account-types'
import type { UplinkStatus } from '@solus/contracts/uplink'

/**
 * The "Connect to Solus Cloud" row on the optional last stage of desktop
 * onboarding. One action does both halves: sign this app in to a Solus account
 * (the browser approves it, and the sign-in registers this Mac to the account),
 * then link this Mac so it is reachable from any browser signed in to that account
 * through a Cloudflare tunnel. Optional, because the desktop app is local by
 * default; the row never blocks the landing.
 */

export interface CloudConnectRow {
  state: 'available' | 'busy' | 'done'
  detail: string
  /** Absent when there is nothing to do, or nothing that can be done. */
  actionLabel?: string
}

export function cloudConnectRow(input: {
  account: AccountState
  uplink: UplinkStatus | undefined
  isLinking: boolean
}): CloudConnectRow {
  const { account, uplink, isLinking } = input
  if (account.kind === 'unavailable') {
    return { state: 'available', detail: 'This computer cannot save the sign-in safely' }
  }
  if (account.kind === 'signing-in') {
    return { state: 'busy', detail: 'Finish signing in in your browser' }
  }
  if (account.kind === 'signed-in') {
    if (uplink?.link.linked) return { state: 'done', detail: `${account.identity.email} · Reachable from the internet` }
    if (isLinking) return { state: 'busy', detail: 'Linking this Mac…' }
    return { state: 'available', detail: account.identity.email, actionLabel: 'Link this Mac' }
  }
  return {
    state: 'available',
    detail: 'Use this Mac from any browser',
    actionLabel: 'Connect',
  }
}
