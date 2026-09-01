import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getElectronModule } from './electron'
import { dataDir } from './paths'

export interface SecretStore {
  loadJson<T>(key: string, electronPath: string): T | null
  saveJson(key: string, electronPath: string, value: unknown): void
  remove(key: string, electronPath: string): void
  canSave(): boolean
}

type ElectronSafeStorage = {
  decryptString(buffer: Buffer): string
  encryptString(value: string): Buffer
  isEncryptionAvailable(): boolean
}

class ElectronSecretStore implements SecretStore {
  constructor(private readonly safeStorage: ElectronSafeStorage) {}

  loadJson<T>(_key: string, electronPath: string): T | null {
    if (!existsSync(electronPath)) return null
    try {
      const encrypted = readFileSync(electronPath)
      return JSON.parse(this.safeStorage.decryptString(encrypted)) as T
    } catch {
      return null
    }
  }

  saveJson(_key: string, electronPath: string, value: unknown): void {
    if (!this.canSave()) throw new Error('Secure storage is unavailable.')
    const encrypted = this.safeStorage.encryptString(JSON.stringify(value))
    writeFileSync(electronPath, encrypted, { mode: 0o600 })
  }

  remove(_key: string, electronPath: string): void {
    if (existsSync(electronPath)) unlinkSync(electronPath)
  }

  canSave(): boolean {
    return this.safeStorage.isEncryptionAvailable()
  }
}

class FileSecretStore implements SecretStore {
  private fileFor(key: string): string {
    return join(dataDir(), 'secrets', `${key}.json`)
  }

  loadJson<T>(key: string, _electronPath: string): T | null {
    const path = this.fileFor(key)
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T
    } catch {
      return null
    }
  }

  saveJson(key: string, _electronPath: string, value: unknown): void {
    const dir = join(dataDir(), 'secrets')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    const path = this.fileFor(key)
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
    chmodSync(path, 0o600)
  }

  remove(key: string, _electronPath: string): void {
    const path = this.fileFor(key)
    if (existsSync(path)) unlinkSync(path)
  }

  canSave(): boolean {
    return true
  }
}

let store: SecretStore | null = null

export function secretStore(): SecretStore {
  if (store) return store
  const safeStorage = getElectronModule()?.safeStorage
  if (safeStorage && typeof safeStorage === 'object') {
    const candidate = safeStorage as Partial<ElectronSafeStorage>
    if (
      typeof candidate.decryptString === 'function' &&
      typeof candidate.encryptString === 'function' &&
      typeof candidate.isEncryptionAvailable === 'function'
    ) {
      store = new ElectronSecretStore(candidate as ElectronSafeStorage)
      return store
    }
  }
  store = new FileSecretStore()
  return store
}
