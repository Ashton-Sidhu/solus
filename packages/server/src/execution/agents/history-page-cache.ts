import { stat } from 'node:fs/promises'
import type { ProviderHistoryPage } from '@solus/contracts/session-history'

/** File identity and both change clocks. A replacement, rewrite of the same length,
 * or append invalidates all windows, even if the writer restores the modification time. */
export async function historyFileRevision(path: string): Promise<string | null> {
  try {
    const file = await stat(path, { bigint: true })
    return JSON.stringify([path, ...[file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].map(String)])
  } catch {
    return null
  }
}

/** Keep provider rows before the host adds senders, child results, and question answers.
 * Each reader gets its own rows because those later steps can change them.
 * A key names the provider file, so a page never answers a reader of another file. */
export class ProviderHistoryPages {
  private readonly pages = new Map<string, { revision: string; json: string; bytes: number }>()
  private readonly loading = new Map<string, { revision: string; done: Promise<unknown> }>()
  private bytes = 0

  /** The page from the cache, else from a read of the same page and revision
   * that already runs: a person who opens a session while the host prewarms it
   * waits for that parse instead of starting a second one. */
  async readShared(key: string, revision: string | null): Promise<ProviderHistoryPage | null> {
    const cached = this.read(key, revision)
    if (cached || revision === null) return cached
    const loading = this.loading.get(key)
    if (loading?.revision !== revision) return null
    await loading.done.catch(() => {})
    return this.read(key, revision)
  }

  /** Mark a read of one page and revision as running until `done` settles. */
  reading<T>(key: string, revision: string | null, done: Promise<T>): Promise<T> {
    if (revision === null) return done
    const entry = { revision, done }
    this.loading.set(key, entry)
    const settled = () => { if (this.loading.get(key) === entry) this.loading.delete(key) }
    done.then(settled, settled)
    return done
  }

  read(key: string, revision: string | null): ProviderHistoryPage | null {
    const page = this.pages.get(key)
    if (!page || revision === null || page.revision !== revision) return null
    this.pages.delete(key)
    this.pages.set(key, page)
    return JSON.parse(page.json)
  }

  save(key: string, revision: string, page: ProviderHistoryPage): void {
    const json = JSON.stringify(page)
    const bytes = Buffer.byteLength(json)
    if (bytes > 4 * 1024 * 1024) return
    this.bytes -= this.pages.get(key)?.bytes ?? 0
    this.pages.delete(key)
    this.pages.set(key, { revision, json, bytes })
    this.bytes += bytes
    while (this.bytes > 16 * 1024 * 1024 || this.pages.size > 64) {
      const oldest = this.pages.entries().next().value!
      this.bytes -= oldest[1].bytes
      this.pages.delete(oldest[0])
    }
  }
}
