import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AccountStore, type AccountCipher } from '@solus/desktop-main/account/account-store'
import type { StoredGrant } from '@solus/client-core/oauth-session'

// The store is the only place the desktop's refresh token is persisted. These tests
// pin the two rules that matter: the file never holds the token in the clear, and
// an unavailable keychain refuses to store rather than degrading to plaintext.

const account: StoredGrant = {
  refreshToken: 'secret-refresh-token',
  idToken: 'h.p.s',
  identity: { sub: 'u1', email: 'a@b.co', emailVerified: true, name: 'Ashton', picture: null },
  signedInAt: 1,
}

function reversingCipher(available = true): AccountCipher {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from([...plain].reverse().join('')),
    decryptString: (encrypted) => [...encrypted.toString()].reverse().join(''),
  }
}

function storeIn(cipher: AccountCipher): { store: AccountStore; file: string } {
  const file = join(mkdtempSync(join(tmpdir(), 'solus-account-')), 'nested', 'account.bin')
  return { store: new AccountStore(file, cipher), file }
}

describe('AccountStore', () => {
  test('round-trips through the cipher and never writes the token in the clear', () => {
    const { store, file } = storeIn(reversingCipher())
    store.save(account)
    expect(readFileSync(file, 'utf8')).not.toContain('secret-refresh-token')
    // Windows has no POSIX file modes.
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(store.load()).toEqual(account)
  })

  test('refuses to persist when the keychain is unavailable', () => {
    const { store } = storeIn(reversingCipher(false))
    expect(store.canPersist()).toBe(false)
    expect(() => store.save(account)).toThrow('account_store_encryption_unavailable')
    expect(store.load()).toBeNull()
  })

  test('clear removes the file and load returns null afterwards', () => {
    const { store } = storeIn(reversingCipher())
    store.save(account)
    store.clear()
    expect(store.load()).toBeNull()
  })

  test('a file of the old session-token form reads as signed out, so the install signs in again', () => {
    const { store, file } = storeIn(reversingCipher())
    const old = new AccountStore(file, reversingCipher())
    // SAFETY: writes the pre-OAuth shape on purpose, as an older build left it.
    old.save({ sessionToken: 's', profile: { id: 'u', email: 'a@b.co', name: null, avatarUrl: null }, cloudOrigin: 'https://app.solus.sh', signedInAt: 1, lastVerifiedAt: 1 } as unknown as StoredGrant)
    expect(store.load()).toBeNull()
  })

  test('an unreadable or foreign file reads as signed out, never as a crash', () => {
    const { store, file } = storeIn(reversingCipher())
    store.save(account)
    const other = new AccountStore(file, {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(plain),
      decryptString: () => '{"not":"an account"}',
    })
    expect(other.load()).toBeNull()
  })
})
