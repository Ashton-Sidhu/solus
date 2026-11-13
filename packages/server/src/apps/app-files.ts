import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { APP_FILE_CHUNK_BYTES, APP_FILE_MAX_BYTES, APP_MAX_FILES, type AppCallerKind, type AppFileOperation, type AppFileView } from '@solus/contracts/apps'
import { countFiles, deleteFile, insertFile, listFiles, loadFile, type AppFileRecord } from '../data/apps/app-file-store'
import { emitAppActivity, emitAppDataChanged } from './app-events'
import type { AppStorage, StoredValue } from './app-storage'

/**
 * App files (docs/plans/apps.md §4.3): the files an app holds. A record names
 * each one; its bytes are in the app's `blobs/` folder by the record's id, so
 * no name a person gave is a path on the host. A UI sends a file in parts
 * through its bridge, because one call is small on every transport. The
 * backend writes a file itself and then asks for its record (`add`).
 */

const UPLOAD_IDLE_MS = 10 * 60_000
const MAX_NAME_LENGTH = 255
const ID = /^[A-Za-z0-9-]{1,64}$/

const beginSchema = z.object({ name: z.string().min(1), type: z.string().max(255).default(''), size: z.number().int().min(0) })
const chunkSchema = z.object({ uploadId: z.string(), index: z.number().int().min(0), data: z.string() })
const uploadSchema = z.object({ uploadId: z.string() })
const readSchema = z.object({ id: z.string(), offset: z.number().int().min(0).default(0) })
const idSchema = z.object({ id: z.string() })
const addSchema = z.object({ id: z.string(), name: z.string().min(1), type: z.string().default(''), size: z.number().int().min(0) })

interface Upload {
  appId: string
  name: string
  mediaType: string
  size: number
  received: number
  nextIndex: number
  path: string
  handle: FileHandle
  timer: ReturnType<typeof setTimeout>
}

/** A name as a record keeps it: the last segment of what was given, with no control character. */
function cleanName(name: string): string {
  const base = name.replaceAll('\\', '/').split('/').pop() ?? ''
  const cleaned = [...base].filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join('').trim().slice(0, MAX_NAME_LENGTH)
  return cleaned || 'file'
}

function viewOf(record: AppFileRecord): AppFileView {
  return { id: record.id, name: record.name, type: record.mediaType, size: record.size, createdAt: record.createdAt, createdBy: record.createdBy }
}

export class AppFiles {
  private readonly uploads = new Map<string, Upload>()

  constructor(private readonly storage: Pick<AppStorage, 'folders'>) {}

  private async blobs(appId: string): Promise<string> {
    const folder = join((await this.storage.folders(appId)).appFolder, 'blobs')
    await mkdir(folder, { recursive: true })
    return folder
  }

  async list(appId: string): Promise<AppFileView[]> {
    return (await listFiles(appId)).map(viewOf)
  }

  async get(appId: string, fileId: string): Promise<AppFileView | null> {
    const record = await loadFile(appId, fileId)
    return record ? viewOf(record) : null
  }

  /** One call of a UI on the app's files (§5). `by` is the kind of the caller: a person in a UI here. */
  async call(appId: string, operation: AppFileOperation, input: StoredValue, by: AppCallerKind): Promise<StoredValue> {
    switch (operation) {
      case 'begin': return this.begin(appId, beginSchema.parse(input))
      case 'chunk': return this.chunk(appId, chunkSchema.parse(input))
      case 'commit': return { ...(await this.commit(appId, uploadSchema.parse(input).uploadId, by)) }
      case 'list': return (await this.list(appId)).map((file) => ({ ...file }))
      case 'read': return this.read(appId, readSchema.parse(input))
      case 'remove':
        await this.remove(appId, idSchema.parse(input).id)
        return null
    }
  }

  /** The record of a file the backend wrote itself into `blobs/<id>`. */
  async add(appId: string, input: StoredValue, by: AppCallerKind): Promise<AppFileView> {
    const file = addSchema.parse(input)
    if (!ID.test(file.id)) throw new Error('This is not the id of an app file.')
    const written = await stat(join(await this.blobs(appId), file.id)).then((entry) => (entry.isFile() ? entry.size : null), () => null)
    if (written === null) throw new Error('The file has no bytes on the host.')
    if (written > APP_FILE_MAX_BYTES) {
      await rm(join(await this.blobs(appId), file.id), { force: true })
      throw new Error(`An app file is at most ${APP_FILE_MAX_BYTES / 1024 / 1024} MiB.`)
    }
    await this.assertRoom(appId)
    return this.record(appId, file.id, file.name, file.type, written, by)
  }

  async remove(appId: string, fileId: string): Promise<void> {
    if (!ID.test(fileId)) throw new Error('This is not the id of an app file.')
    if (!(await deleteFile(appId, fileId))) throw new Error('This app has no file with this id.')
    await rm(join(await this.blobs(appId), fileId), { force: true })
    this.changed(appId)
  }

  /** Stops every upload in progress: the host stops. */
  dispose(): void {
    for (const uploadId of this.uploads.keys()) void this.abandon(uploadId)
  }

  private async assertRoom(appId: string): Promise<void> {
    if ((await countFiles(appId)) >= APP_MAX_FILES) throw new Error(`This app holds ${APP_MAX_FILES.toLocaleString('en-US')} files, which is its limit. Remove some first.`)
  }

  private async record(appId: string, id: string, name: string, mediaType: string, size: number, by: AppCallerKind): Promise<AppFileView> {
    const record: AppFileRecord = { id, appId, name: cleanName(name), mediaType: mediaType.trim() || 'application/octet-stream', size, createdBy: by, createdAt: Date.now() }
    await insertFile(record)
    this.changed(appId)
    return viewOf(record)
  }

  /** A UI that lists the files reads again, and so does the Files section of the Manage page. */
  private changed(appId: string): void {
    emitAppDataChanged(appId)
    emitAppActivity(appId, 'files')
  }

  private async begin(appId: string, input: z.infer<typeof beginSchema>): Promise<StoredValue> {
    if (input.size > APP_FILE_MAX_BYTES) throw new Error(`An app file is at most ${APP_FILE_MAX_BYTES / 1024 / 1024} MiB.`)
    await this.assertRoom(appId)
    const uploadId = randomUUID()
    const path = join(await this.blobs(appId), `.upload-${uploadId}`)
    const upload: Upload = {
      appId, name: input.name, mediaType: input.type, size: input.size, received: 0, nextIndex: 0, path,
      handle: await open(path, 'wx'),
      timer: setTimeout(() => void this.abandon(uploadId), UPLOAD_IDLE_MS),
    }
    upload.timer.unref?.()
    this.uploads.set(uploadId, upload)
    return { uploadId }
  }

  private upload(appId: string, uploadId: string): Upload {
    const upload = this.uploads.get(uploadId)
    if (!upload || upload.appId !== appId) throw new Error('This upload is not in progress. Start it again.')
    return upload
  }

  private async chunk(appId: string, input: z.infer<typeof chunkSchema>): Promise<StoredValue> {
    const upload = this.upload(appId, input.uploadId)
    if (input.index !== upload.nextIndex) throw new Error('The parts of an upload come in order. Start it again.')
    const bytes = Buffer.from(input.data, 'base64')
    if (bytes.length > APP_FILE_CHUNK_BYTES) throw new Error(`One part of an upload is at most ${APP_FILE_CHUNK_BYTES / 1024} KiB.`)
    if (upload.received + bytes.length > upload.size) throw new Error('The upload is larger than it said.')
    await upload.handle.write(bytes)
    upload.received += bytes.length
    upload.nextIndex += 1
    upload.timer.refresh()
    return null
  }

  private async commit(appId: string, uploadId: string, by: AppCallerKind): Promise<AppFileView> {
    const upload = this.upload(appId, uploadId)
    if (upload.received !== upload.size) {
      await this.abandon(uploadId)
      throw new Error('The upload ended before all of the file arrived. Send it again.')
    }
    this.uploads.delete(uploadId)
    clearTimeout(upload.timer)
    await upload.handle.close()
    const id = randomUUID()
    await rename(upload.path, join(await this.blobs(appId), id))
    return this.record(appId, id, upload.name, upload.mediaType, upload.size, by)
  }

  private async abandon(uploadId: string): Promise<void> {
    const upload = this.uploads.get(uploadId)
    if (!upload) return
    this.uploads.delete(uploadId)
    clearTimeout(upload.timer)
    await upload.handle.close().catch(() => {})
    await rm(upload.path, { force: true })
  }

  private async read(appId: string, input: z.infer<typeof readSchema>): Promise<StoredValue> {
    if (!ID.test(input.id)) throw new Error('This is not the id of an app file.')
    const record = await loadFile(appId, input.id)
    if (!record) throw new Error('This app has no file with this id.')
    const handle = await open(join(await this.blobs(appId), record.id), 'r')
    try {
      const buffer = Buffer.alloc(Math.max(0, Math.min(APP_FILE_CHUNK_BYTES, record.size - input.offset)))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, input.offset)
      const end = input.offset + bytesRead
      return { data: buffer.subarray(0, bytesRead).toString('base64'), size: record.size, nextOffset: end < record.size && bytesRead > 0 ? end : null }
    } finally {
      await handle.close()
    }
  }
}
