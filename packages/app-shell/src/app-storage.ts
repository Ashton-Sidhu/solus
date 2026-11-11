/**
 * The app's own data on the host (docs/plans/apps.md §4): `storage.get(key)`,
 * `.set(key, value)`, `.delete(key)`, and `.keys()`. Each is one `tools/call`
 * under a reserved call name (`appStorageCallName` in `@solus/contracts/apps`),
 * so it needs no channel of its own. The data belongs to the app, not to a
 * viewer.
 */

import type { ToolArguments, ToolValue } from './host-bridge'

export type ValueCall = (name: string, args: ToolArguments) => Promise<ToolValue>

export interface AppStorage {
  /** The value kept under a key; null when there is none. */
  get(key: string): Promise<ToolValue>
  set(key: string, value: ToolValue): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

export function createStorage(call: ValueCall): AppStorage {
  return {
    get: (key) => call('@storage/get', { key }),
    set: async (key, value) => {
      await call('@storage/set', { key, value })
    },
    delete: async (key) => {
      await call('@storage/delete', { key })
    },
    keys: async () => {
      const keys = await call('@storage/keys', {})
      return Array.isArray(keys) ? keys.map(String) : []
    },
  }
}
