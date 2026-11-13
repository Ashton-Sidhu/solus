import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { dataDir } from '../platform/paths'
import { renameRetrying } from '../platform/rename-retry'

/**
 * An app's own data on the host (docs/plans/apps.md §4.3), under
 * `<data dir>/apps/data/<app id>/`: `storage.json` is its key-value storage,
 * `app.sqlite` is the database only its runner opens, and `files/` is the
 * folder its backend may always read and write. The data belongs to the app,
 * not to a viewer.
 */

const MAX_STORAGE_BYTES = 8 * 1024 * 1024
const MAX_KEYS = 2000
const MAX_KEY_LENGTH = 256

const storedValueSchema = z.json()
export type StoredValue = z.infer<typeof storedValueSchema>
const storageFileSchema = z.record(z.string(), storedValueSchema)
type StorageFile = z.infer<typeof storageFileSchema>

export class AppStorage {
  /** One writer at a time for each app: a write reads the file, so two at once would lose one. */
  private readonly writes = new Map<string, Promise<void>>()

  constructor(private readonly root: () => string = () => join(dataDir(), 'apps', 'data')) {}

  /** The app's folder. An app id is a path segment here, so one that is not is refused. */
  private folder(appId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(appId)) throw new Error('This app has no data folder: its id is not a folder name.')
    return join(this.root(), appId)
  }

  /** The app's folder and its `files/` folder, which the backend may always read and write. Made on first use. */
  async folders(appId: string): Promise<{ appFolder: string; filesDir: string }> {
    const appFolder = this.folder(appId)
    const filesDir = join(appFolder, 'files')
    await mkdir(filesDir, { recursive: true })
    return { appFolder, filesDir }
  }

  async get(appId: string, key: string): Promise<StoredValue> {
    await this.writes.get(appId)
    return (await this.read(appId))[checkedKey(key)] ?? null
  }

  async keys(appId: string): Promise<string[]> {
    await this.writes.get(appId)
    return Object.keys(await this.read(appId))
  }

  set(appId: string, key: string, value: StoredValue): Promise<void> {
    const name = checkedKey(key)
    return this.change(appId, (stored) => {
      if (!(name in stored) && Object.keys(stored).length >= MAX_KEYS) throw new Error(`This app's storage holds ${MAX_KEYS} keys, which is its limit.`)
      stored[name] = value
    })
  }

  delete(appId: string, key: string): Promise<void> {
    const name = checkedKey(key)
    return this.change(appId, (stored) => {
      delete stored[name]
    })
  }

  /** Removes everything the app kept on this host. */
  async remove(appId: string): Promise<void> {
    await this.writes.get(appId)?.catch(() => {})
    await rm(this.folder(appId), { recursive: true, force: true })
  }

  private async read(appId: string): Promise<StorageFile> {
    let text: string
    try {
      text = await readFile(join(this.folder(appId), 'storage.json'), 'utf8')
    } catch {
      return {}
    }
    return storageFileSchema.parse(JSON.parse(text))
  }

  private change(appId: string, apply: (stored: StorageFile) => void): Promise<void> {
    const run = (this.writes.get(appId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const stored = await this.read(appId)
      apply(stored)
      const text = JSON.stringify(stored)
      if (Buffer.byteLength(text) > MAX_STORAGE_BYTES) throw new Error('This app\'s storage is full: it holds at most 8 MiB.')
      const folder = this.folder(appId)
      await mkdir(folder, { recursive: true })
      const temporary = join(folder, `storage.json.${process.pid}.tmp`)
      await writeFile(temporary, text)
      await renameRetrying(temporary, join(folder, 'storage.json'))
    })
    this.writes.set(appId, run)
    void run.catch(() => {}).finally(() => {
      if (this.writes.get(appId) === run) this.writes.delete(appId)
    })
    return run
  }
}

function checkedKey(key: string): string {
  if (!key || key.length > MAX_KEY_LENGTH) throw new Error(`A storage key is 1 to ${MAX_KEY_LENGTH} characters.`)
  return key
}
