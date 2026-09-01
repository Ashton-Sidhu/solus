import { createHash, randomBytes } from 'crypto'
import { mkdir, open, unlink } from 'fs/promises'
import { basename, join } from 'path'
import type { AttachmentUploadRequest } from '../../../shared/rpc'
import {
  MAX_ATTACHMENT_UPLOAD_BYTES,
  MAX_ATTACHMENT_UPLOAD_COUNT,
} from '../../../shared/rpc'
import type { IpcContext } from '../../../shared/types'
import { dataDir } from '../../platform/paths'
import type { SolusServer } from '../server'

export interface AttachmentHandlerDeps {
  attachmentsDir?: string
}

function sessionFolderName(sessionId: string): string {
  const label = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48) || 'session'
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
  return `${label}-${digest}`
}

function safeFileName(name: string): string {
  const leaf = basename(name.replaceAll('\\', '/'))
  return leaf.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96) || 'attachment'
}

function decodeAttachmentDataUrl(request: AttachmentUploadRequest): Buffer {
  if (!request || typeof request.name !== 'string' || typeof request.mime !== 'string' || typeof request.dataUrl !== 'string') {
    throw new Error('Invalid attachment upload.')
  }
  if (!/^[a-z0-9][a-z0-9!#$&^_.+\/-]{0,126}$/i.test(request.mime)) {
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
  const sessionId = ctx?.session?.sessionId
  if (!sessionId) throw new Error('A session is required to upload an attachment.')
  const buffer = decodeAttachmentDataUrl(request)
  const root = deps.attachmentsDir ?? join(dataDir(), 'attachments')
  const sessionDir = join(root, sessionFolderName(sessionId))
  await mkdir(sessionDir, { recursive: true })

  const displayName = safeFileName(request.name)

  for (let slot = 0; slot < MAX_ATTACHMENT_UPLOAD_COUNT; slot++) {
    const lockPath = join(sessionDir, `.slot-${slot}`)
    let lock: Awaited<ReturnType<typeof open>> | undefined
    try {
      lock = await open(lockPath, 'wx', 0o600)
      await lock.close()
    } catch (error: unknown) {
      await lock?.close().catch(() => {})
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') continue
      throw error
    }

    const filePath = join(sessionDir, `${slot}-${randomBytes(6).toString('hex')}-${displayName}`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(filePath, 'wx', 0o600)
      await handle.writeFile(buffer)
      await handle.close()
      return filePath
    } catch (error: unknown) {
      await handle?.close().catch(() => {})
      await unlink(filePath).catch(() => {})
      await unlink(lockPath).catch(() => {})
      throw error
    }
  }

  throw new Error(`A session can contain at most ${MAX_ATTACHMENT_UPLOAD_COUNT} uploaded attachments.`)
}

export function registerAttachmentHandlers(server: SolusServer, deps: AttachmentHandlerDeps = {}): void {
  server.register('attachUpload', async (args) => {
    const [ctx, request] = args as [IpcContext, AttachmentUploadRequest]
    return writeAttachmentUpload(ctx, request, deps)
  })
}
