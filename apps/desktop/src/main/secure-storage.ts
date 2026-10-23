import type { PlatformSafeStorage } from '@solus/server/platform/services'

interface DesktopCipher extends PlatformSafeStorage {
  getSelectedStorageBackend(): string
}

/** Linux basic_text uses a fixed password and must not hold account secrets. */
export function secureStorage(cipher: DesktopCipher, platform = process.platform): PlatformSafeStorage {
  const isEncryptionAvailable = () => cipher.isEncryptionAvailable()
    && (platform !== 'linux' || cipher.getSelectedStorageBackend() !== 'basic_text')
  return {
    isEncryptionAvailable,
    encryptString(value) {
      if (!isEncryptionAvailable()) throw new Error('A secure desktop keyring is required. Unlock or install GNOME Keyring or KWallet, then try again.')
      return cipher.encryptString(value)
    },
    decryptString(value) {
      if (!isEncryptionAvailable()) throw new Error('The desktop keyring is unavailable.')
      return cipher.decryptString(value)
    },
  }
}
