import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AccountStore, type AccountCipher, type StoredAccount } from '@solus/desktop-main/account/account-store'

// The store is the only place the account session token is persisted. These tests
// pin the two rules that matter: the file never holds the token in the clear, and
// an unavailable keychain refuses to store rather than degrading to plaintext.

const account: StoredAccount = {
  sessionToken: 'secret-session-token',
  profile: { id: 'u1', email: 'a@b.co', name: 'Ashton', avatarUrl: null },
  cloudOrigin: 'https://app.solus.sh',
  signedInAt: 1,
  lastVerifiedAt: 1,
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
    expect(readFileSync(file, 'utf8')).not.toContain('secret-session-token')
    expect(statSync(file).mode & 0o777).toBe(0o600)
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
