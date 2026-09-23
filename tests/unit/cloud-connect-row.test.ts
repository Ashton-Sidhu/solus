import { describe, expect, test } from 'bun:test'
import { cloudConnectRow } from '@solus/workspace-ui/components/onboarding/lib/cloud-connect-row'
import type { AccountState } from '@solus/contracts/account-types'
import type { UplinkStatus } from '@solus/contracts/uplink'

// The optional desktop "Connect to Solus Cloud" row (docs/plans/cloud-onboarding.md §4):
// sign in, then link this Mac. Each state says what is true and offers only what can be done.

const SIGNED_IN: AccountState = {
  kind: 'signed-in',
  profile: { id: 'ada', email: 'ada@example.test', name: 'Ada', avatarUrl: null },
  consoleUrl: 'https://app.solus.test',
  signedInAt: 1,
  lastVerifiedAt: 1,
  isStale: false,
}
const LINKED = { linked: true } as UplinkStatus

describe('the Connect to Solus Cloud row', () => {
  test('signed out, it offers one action that does both halves', () => {
    expect(cloudConnectRow({ account: { kind: 'signed-out' }, uplink: undefined, isLinking: false }))
      .toMatchObject({ state: 'available', actionLabel: 'Connect' })
    expect(cloudConnectRow({ account: { kind: 'invalid', reason: 'expired' }, uplink: undefined, isLinking: false }).actionLabel)
      .toBe('Connect')
  })

  test('while the browser approves, it shows the code to confirm and offers nothing', () => {
    const row = cloudConnectRow({
      account: { kind: 'signing-in', userCode: 'BCDF-GHJK', verificationUrl: 'https://app/device', expiresAt: 2 },
      uplink: undefined,
      isLinking: false,
    })
    expect(row).toEqual({ state: 'busy', detail: 'Confirm BCDF-GHJK in your browser' })
  })

  test('signed in but not linked, the remaining half is offered; linked, it is done', () => {
    expect(cloudConnectRow({ account: SIGNED_IN, uplink: { linked: false }, isLinking: false }))
      .toMatchObject({ state: 'available', actionLabel: 'Link this Mac' })
    expect(cloudConnectRow({ account: SIGNED_IN, uplink: { linked: false }, isLinking: true }).state).toBe('busy')
    expect(cloudConnectRow({ account: SIGNED_IN, uplink: LINKED, isLinking: false }))
      .toEqual({ state: 'done', detail: 'ada@example.test · This Mac is linked' })
  })

  test('a Mac that cannot store the sign-in says so and offers no action it cannot keep', () => {
    expect(cloudConnectRow({ account: { kind: 'unavailable', reason: 'encryption' }, uplink: undefined, isLinking: false }).actionLabel)
      .toBeUndefined()
  })
})
