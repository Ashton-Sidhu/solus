/**
 * What the native feature logic needs from the device. The Expo adapters live
 * beside this file; tests pass in-memory versions. Nothing here is a DOM shim.
 */

/** Synchronous, non-secret key-value storage: host metadata, drafts, the
 *  send outbox, and bounded caches. Never a credential. */
export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  keys(): string[]
}

/** The device keychain. Holds only credentials: host session tokens and the
 *  Solus account session. Never transcripts or queues. */
export interface SecretStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export function memoryKeyValueStore(): KeyValueStore {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    keys: () => [...values.keys()],
  }
}

export function memorySecretStore(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => void values.set(key, value),
    delete: async (key) => void values.delete(key),
  }
}

/** Removes every key under a prefix. Forgetting a host or an account is total. */
export function removeKeysWithPrefix(store: KeyValueStore, prefix: string): void {
  for (const key of store.keys()) if (key.startsWith(prefix)) store.removeItem(key)
}
