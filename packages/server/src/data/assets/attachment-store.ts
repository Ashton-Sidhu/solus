import { createHash, randomBytes } from 'crypto'
import { mkdir, open, unlink } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { z } from 'zod'
import type { AttachmentUploadRequest } from '@solus/contracts/rpc'
import { MAX_ATTACHMENT_UPLOAD_BYTES, MAX_ATTACHMENT_UPLOAD_COUNT } from '@solus/contracts/rpc'
import { VIDEO_FILE_EXTENSIONS, videoMimeType } from '@solus/contracts/media-types'
import { dataDir } from '../../platform/paths'

/**
 * The host's attachment store: files a client or another host uploaded for a
 * conversation, one folder per conversation. A prompt's image refs name files
 * here, and a run reads an image only from here (`resolvePromptImages`).
 */

export function attachmentsRoot(): string {
  return join(dataDir(), 'attachments')
}

/** An image ref as it crosses a process or a host. */
export const promptImageRefSchema = z.object({ mimeType: z.string(), hostPath: z.string(), name: z.string().optional() })

export function uploadFolderName(bucketId: string): string {
  const label = bucketId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48) || 'session'
  const digest = createHash('sha256').update(bucketId).digest('hex').slice(0, 12)
  return `${label}-${digest}`
}

function safeFileName(name: string): string {
  const leaf = basename(name.replaceAll('\\', '/'))
  return leaf.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96) || 'attachment'
}

export function assertAttachmentMime(mime: string): void {
  if (!/^[a-z0-9][a-z0-9!#$&^_.+/-]{0,126}$/i.test(mime)) {
    throw new Error('Invalid attachment MIME type.')
  }
}

function decodeAttachmentDataUrl(request: AttachmentUploadRequest): Buffer {
  assertAttachmentMime(request.mime)
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

export async function attachmentUploadPath(
  bucketId: string,
  name: string,
  mime: string,
  attachmentsDir = attachmentsRoot(),
): Promise<string> {
  const bucketDir = join(attachmentsDir, uploadFolderName(bucketId))
  await mkdir(bucketDir, { recursive: true })

  let leaf = safeFileName(name)
  const video = videoMimeType({ name, mimeType: mime })
  if (video && videoMimeType({ name: leaf }) !== video) {
    const extension = VIDEO_FILE_EXTENSIONS.find((extension) => videoMimeType({ name: `file.${extension}` }) === video)
    if (extension) leaf += `.${extension}`
  }
  return join(bucketDir, `${randomBytes(12).toString('hex')}-${leaf}`)
}

/** Reserve when bytes arrive. Release failed uploads, but keep the slot for
 * completed files. The exclusive lock enforces the cap across concurrent calls. */
export async function reserveAttachmentSlot(bucketDir: string): Promise<() => Promise<void>> {
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
    return () => unlink(lockPath).catch(() => {})
  }

  throw new Error(`A conversation can contain at most ${MAX_ATTACHMENT_UPLOAD_COUNT} uploaded attachments.`)
}

/** Decode and persist one attachment in a conversation's upload folder. */
export async function storeAttachment(
  bucketId: string,
  request: AttachmentUploadRequest,
  attachmentsDir?: string,
): Promise<string> {
  const buffer = decodeAttachmentDataUrl(request)
  const filePath = await attachmentUploadPath(bucketId, request.name, request.mime, attachmentsDir)
  const release = await reserveAttachmentSlot(dirname(filePath))
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(filePath, 'wx', 0o600)
    await handle.writeFile(buffer)
    await handle.close()
    return filePath
  } catch (error) {
    await handle?.close().catch(() => {})
    await unlink(filePath).catch(() => {})
    await release()
    throw error
  }
}
