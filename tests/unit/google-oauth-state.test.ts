import { describe, expect, test } from 'bun:test'
import { validateOAuthStateNonce } from '../../src/main/google/oauth'

describe('Google OAuth state nonce validation', () => {
  test('accepts only the expected nonce before expiry', () => {
    const now = 1_000

    expect(validateOAuthStateNonce('state-a', 'state-a', now + 1, now)).toBe(true)
    expect(validateOAuthStateNonce('state-a', 'state-b', now + 1, now)).toBe(false)
    expect(validateOAuthStateNonce('state-a', null, now + 1, now)).toBe(false)
    expect(validateOAuthStateNonce(undefined, 'state-a', now + 1, now)).toBe(false)
    expect(validateOAuthStateNonce('state-a', 'state-a', now - 1, now)).toBe(false)
  })
})
