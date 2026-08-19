import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { z } from 'zod'
import { dataDir } from './paths'
import { platformServices, type PlatformSafeStorage } from './services'

export interface SecretStore {
  loadJson<T>(key: string, electronPath: string, schema: z.ZodType<T>): T | null
  saveJson<T>(key: string, electronPath: string, value: T): void
  remove(key: string, electronPath: string): void
  canSave(): boolean
}

class ElectronSecretStore implements SecretStore {
  constructor(private readonly safeStorage: PlatformSafeStorage) {}

  loadJson<T>(_key: string, electronPath: string, schema: z.ZodType<T>): T | null {
    if (!existsSync(electronPath)) return null
    try {
      const encrypted = readFileSync(electronPath)
      const parsed = schema.safeParse(JSON.parse(this.safeStorage.decryptString(encrypted)))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  saveJson<T>(_key: string, electronPath: string, value: T): void {
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

  loadJson<T>(key: string, _electronPath: string, schema: z.ZodType<T>): T | null {
    const path = this.fileFor(key)
    if (!existsSync(path)) return null
    try {
      const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  saveJson<T>(key: string, _electronPath: string, value: T): void {
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
  const safeStorage = platformServices().safeStorage
  if (safeStorage) {
    store = new ElectronSecretStore(safeStorage)
    return store
  }
  store = new FileSecretStore()
  return store
}
