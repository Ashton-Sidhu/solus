import { describe, expect, test } from 'bun:test'
import { accountConnectionAction, accountConnectionDescription } from '@solus/workspace-ui/components/seats/lib/cloud-connections'

/**
 * A connection kept in the Solus account opens the account's page. The button
 * names what that page will do, so a connected account never asks to connect
 * again, and the reason to connect shows only while it is not connected.
 */

const purpose = 'Publish Google Docs from works and plans.'

describe('account connection row', () => {
  test('the verb follows the status', () => {
    expect(accountConnectionAction({ kind: 'connected', label: 'ada' })).toBe('Manage')
    expect(accountConnectionAction({ kind: 'needs-sign-in' })).toBe('Sign in again')
    expect(accountConnectionAction({ kind: 'not-connected' })).toBe('Connect')
    expect(accountConnectionAction(null)).toBe('Open account')
  })

  test('the purpose shows only while it is not connected', () => {
    expect(accountConnectionDescription({ kind: 'not-connected' }, purpose)).toBe(`Not connected. ${purpose}`)
    expect(accountConnectionDescription({ kind: 'connected', label: 'ada' }, purpose)).toBe('Connected in your Solus account as ada')
    expect(accountConnectionDescription({ kind: 'failed', message: 'Solus could not reach your account.' }, purpose)).toBe('Solus could not reach your account.')
  })
})
