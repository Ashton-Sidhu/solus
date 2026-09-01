import { createHash, randomBytes } from 'crypto'
import { mkdir, open, unlink } from 'fs/promises'
import { basename, join } from 'path'
import type { AttachmentUploadRequest } from '@solus/contracts/rpc'
import {
  MAX_ATTACHMENT_UPLOAD_BYTES,
  MAX_ATTACHMENT_UPLOAD_COUNT,
} from '@solus/contracts/rpc'
import type { IpcContext } from '@solus/contracts/types'
import { dataDir } from '../../platform/paths'
import type { SolusServer } from '../server'

export interface AttachmentHandlerDeps {
  attachmentsDir?: string
}

/**
 * Which conversation's folder an upload belongs to. Uploads are stored per
 * conversation so one session cannot read another's files and so the count cap
 * has something to count against — neither needs the conversation to have
 * *started*. A draft owns a run, a working directory, and a prompt holding the
 * attachments, so it is a bucket in its own right; the folder it mints keeps
 * its name after the draft starts a session, because the path already travelled
 * to the client as `hostPath`.
 */
export function uploadBucketId(ctx: IpcContext | undefined): string | undefined {
  return ctx?.session?.sessionId || ctx?.session?.draftId || undefined
}

export function uploadFolderName(bucketId: string): string {
  const label = bucketId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48) || 'session'
  const digest = createHash('sha256').update(bucketId).digest('hex').slice(0, 12)
  return `${label}-${digest}`
}

function safeFileName(name: string): string {
  const leaf = basename(name.replaceAll('\\', '/'))
  return leaf.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96) || 'attachment'
}

function decodeAttachmentDataUrl(request: AttachmentUploadRequest): Buffer {
  if (!/^[a-z0-9][a-z0-9!#$&^_.+/-]{0,126}$/i.test(request.mime)) {
    throw new Error('Invalid attachment MIME type.')
  }
  const match = request.dataUrl.match(/^data:([^;,]+);base64,([a-zA-Z0-9+/]*={0,2})$/)
  if (!match || match[1].toLowerCase() !== request.mime.toLowerCase()) {
    throw new Error('Invalid attachment data URL.')
  }
  const base64 = match[2]
  const maxBase64Length = Math.ceil(MAX_ATTACHMENT_UPLOAD_BYTES / 3) * 4
  if (base64.length > maxBase64Length) throw new Error('Attachment exceeds the 10 MB limit.')
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length > MAX_ATTACHMENT_UPLOAD_BYTES) throw new Error('Attachment exceeds the 10 MB limit.')
  return buffer
}

/** Decode and persist one attachment on the session's owning host. */
export async function writeAttachmentUpload(
  ctx: IpcContext,
  request: AttachmentUploadRequest,
  deps: AttachmentHandlerDeps = {},
): Promise<string> {
  const bucketId = uploadBucketId(ctx)
  if (!bucketId) throw new Error('A conversation is required to upload an attachment.')
  const buffer = decodeAttachmentDataUrl(request)
  const root = deps.attachmentsDir ?? join(dataDir(), 'attachments')
  const bucketDir = join(root, uploadFolderName(bucketId))
  await mkdir(bucketDir, { recursive: true })

  const displayName = safeFileName(request.name)

  for (let slot = 0; slot < MAX_ATTACHMENT_UPLOAD_COUNT; slot++) {
    const lockPath = join(bucketDir, `.slot-${slot}`)
    let lock: Awaited<ReturnType<typeof open>> | undefined
    try {
      lock = await open(lockPath, 'wx', 0o600)
      await lock.close()
    } catch (error) {
      await lock?.close().catch(() => {})
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') continue
      throw error
    }

    const filePath = join(bucketDir, `${slot}-${randomBytes(6).toString('hex')}-${displayName}`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(filePath, 'wx', 0o600)
      await handle.writeFile(buffer)
      await handle.close()
      return filePath
    } catch (error) {
      await handle?.close().catch(() => {})
      await unlink(filePath).catch(() => {})
      await unlink(lockPath).catch(() => {})
      throw error
    }
  }

  throw new Error(`A conversation can contain at most ${MAX_ATTACHMENT_UPLOAD_COUNT} uploaded attachments.`)
}

export function registerAttachmentHandlers(server: SolusServer, deps: AttachmentHandlerDeps = {}): void {
  server.register('attachUpload', async (args) => {
    const [ctx, request] = args
    return writeAttachmentUpload(ctx, request, deps)
  })
}
