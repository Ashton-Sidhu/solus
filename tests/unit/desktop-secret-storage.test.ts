import { expect, test } from 'bun:test'
import { secureStorage } from '@solus/desktop-main/secure-storage'

test('Linux rejects basic_text even when Electron reports encryption available', () => {
  const storage = secureStorage({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text', encryptString: () => { throw new Error('must not encrypt') }, decryptString: () => { throw new Error('must not decrypt') } }, 'linux')
  expect(storage.isEncryptionAvailable()).toBe(false)
  expect(() => storage.encryptString('test')).toThrow('secure desktop keyring')
  expect(() => storage.decryptString(Buffer.from('test'))).toThrow('unavailable')
})

test('a locked keyring can recover without replacing the storage owner', () => {
  let unlocked = false
  const storage = secureStorage({ isEncryptionAvailable: () => unlocked, getSelectedStorageBackend: () => 'gnome_libsecret', encryptString: value => Buffer.from(value), decryptString: value => value.toString() }, 'linux')
  expect(storage.isEncryptionAvailable()).toBe(false)
  unlocked = true
  expect(storage.isEncryptionAvailable()).toBe(true)
  expect(storage.decryptString(storage.encryptString('fixture'))).toBe('fixture')
})
