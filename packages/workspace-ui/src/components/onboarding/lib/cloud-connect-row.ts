import type { AccountState } from '@solus/contracts/account-types'
import type { UplinkStatus } from '@solus/contracts/uplink'

/**
 * The optional "Connect to Solus Cloud" row at the end of desktop onboarding
 * (docs/plans/cloud-onboarding.md §4). One action does both halves: sign this
 * app in to a Solus account (the browser approves it), then link this Mac so
 * it is reachable from any browser signed in to that account. Optional,
 * because the desktop app is local by default; the row never blocks Start.
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
    return { state: 'available', detail: 'This Mac cannot store the sign-in safely. Try again from Settings.' }
  }
  if (account.kind === 'signing-in') {
    return { state: 'busy', detail: `Confirm ${account.userCode} in your browser` }
  }
  if (account.kind === 'signed-in') {
    if (uplink?.linked) return { state: 'done', detail: `${account.profile.email} · This Mac is linked` }
    if (isLinking) return { state: 'busy', detail: 'Linking this Mac…' }
    return { state: 'available', detail: `Signed in as ${account.profile.email}`, actionLabel: 'Link this Mac' }
  }
  return {
    state: 'available',
    detail: 'Optional. Reach this Mac from any browser, and share it with your team.',
    actionLabel: 'Connect',
  }
}
