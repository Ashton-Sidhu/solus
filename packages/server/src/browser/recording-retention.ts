import { existsSync, readFileSync } from 'fs'
import { mkdir, rename, unlink, writeFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { z } from 'zod'
import { createLogger } from '../logger'
import { dataDir } from '../platform/paths'
import { ASSET_ID, storedAssetPath } from '../server/asset-paths'

/**
 * Which recordings the host keeps.
 *
 * A recording is up to 50 MB, and most are made to look at once. Only a
 * recording filed on a task or a pull request is kept; the rest are deleted a
 * day after they were made, which gives the user time to file or send one.
 *
 * The index is a small file of recording asset ids, because the asset store is
 * content-addressed and cannot say which of its files are recordings. The sweep
 * deletes only files this index names, so it can never remove an image or an
 * upload.
 */

const log = createLogger('browser', 'recording-retention.ts')

export const UNFILED_RECORDING_TTL_MS = 24 * 60 * 60 * 1000
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000

interface RecordingEntry {
  assetId: string
  createdAt: number
  filed: boolean
}

const indexSchema = z.object({
  version: z.literal(1),
  recordings: z.array(z.object({
    assetId: z.string(),
    createdAt: z.number(),
    filed: z.boolean(),
  })).catch([]),
})

export class RecordingRetention {
  private entries: Map<string, RecordingEntry> | null = null
  /** Writes are ordered, so two recordings saved together cannot lose one. */
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly options: { statePath?: string; assetsDir?: string } = {}) {}

  /** A recording was stored. Unfiled until something files it. */
  noteRecording(assetId: string, createdAt: number): Promise<void> {
    return this.change((entries) => {
      if (entries.has(assetId)) return false
      entries.set(assetId, { assetId, createdAt, filed: false })
      return true
    })
  }

  /** A recording was filed on a task or a pull request, so it stays. A no-op
   *  for an asset that is not a recording. */
  markFiled(assetId: string): Promise<void> {
    return this.change((entries) => {
      const entry = entries.get(assetId)
      if (!entry || entry.filed) return false
      entry.filed = true
      return true
    })
  }

  /**
   * Keep every recording a sent prompt names. The composer sends a file as an
   * `[Attached file: <host path>]` line, so a recording the user sent to an
   * agent is referenced by the transcript and must outlive the sweep.
   */
  keepRecordingsSentIn(prompt: string): Promise<void> {
    const assetIds = recordingAssetIdsIn(prompt, this.options.assetsDir)
    if (assetIds.length === 0) return Promise.resolve()
    return this.change((entries) => {
      let changed = false
      for (const assetId of assetIds) {
        const entry = entries.get(assetId)
        if (!entry || entry.filed) continue
        entry.filed = true
        changed = true
      }
      return changed
    })
  }

  /** Delete every unfiled recording older than the TTL. Returns the ids it
   *  deleted. */
  async sweep(now = Date.now()): Promise<string[]> {
    const deleted: string[] = []
    await this.change(async (entries) => {
      for (const entry of entries.values()) {
        if (entry.filed || now - entry.createdAt < UNFILED_RECORDING_TTL_MS) continue
        await unlink(storedAssetPath(entry.assetId, this.options.assetsDir)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
        entries.delete(entry.assetId)
        deleted.push(entry.assetId)
      }
      return deleted.length > 0
    })
    if (deleted.length > 0) log.info('browser_recordings_swept', { count: deleted.length })
    return deleted
  }

  /** Apply one change in order, and write the index only when it changed:
   *  a host that never records never creates the file. */
  private change(mutate: (entries: Map<string, RecordingEntry>) => boolean | Promise<boolean>): Promise<void> {
    const next = this.writes.then(async () => {
      const entries = this.load()
      if (await mutate(entries)) await this.save(entries)
    })
    this.writes = next.catch(() => {})
    return next
  }

  private load(): Map<string, RecordingEntry> {
    if (this.entries) return this.entries
    const entries = new Map<string, RecordingEntry>()
    const path = this.statePath()
    if (existsSync(path)) {
      try {
        const parsed = indexSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
        if (parsed.success) for (const entry of parsed.data.recordings) entries.set(entry.assetId, entry)
      } catch (error) {
        log.warn('browser_recording_index_unreadable', { message: error instanceof Error ? error.message : String(error) })
      }
    }
    this.entries = entries
    return entries
  }

  private async save(entries: Map<string, RecordingEntry>): Promise<void> {
    const path = this.statePath()
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify({ version: 1, recordings: [...entries.values()] }), { mode: 0o600 })
    await rename(temporary, path)
  }

  private statePath(): string {
    return this.options.statePath ?? join(dataDir(), 'state', 'browser-recordings.json')
  }
}

const ATTACHED_FILE_LINE = /^\[Attached file: (.+)\]$/gm

/** Stored asset ids named by attached-file lines that point into the asset store. */
function recordingAssetIdsIn(prompt: string, assetsDir?: string): string[] {
  const ids: string[] = []
  for (const match of prompt.matchAll(ATTACHED_FILE_LINE)) {
    const path = match[1].trim()
    const assetId = basename(path)
    if (!ASSET_ID.test(assetId)) continue
    if (path !== storedAssetPath(assetId, assetsDir)) continue
    ids.push(assetId)
  }
  return ids
}

let retention: RecordingRetention | null = null

/** The host's one index. Lazy, so `SOLUS_DATA_DIR` can be set first. */
export function recordingRetention(): RecordingRetention {
  retention ??= new RecordingRetention()
  return retention
}

/** Sweep now and every six hours. Returns the stop. */
export function startRecordingSweep(target: RecordingRetention = recordingRetention()): () => void {
  const sweep = (): void => {
    void target.sweep().catch((error) => {
      log.warn('browser_recording_sweep_failed', { message: error instanceof Error ? error.message : String(error) })
    })
  }
  sweep()
  const timer = setInterval(sweep, SWEEP_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
