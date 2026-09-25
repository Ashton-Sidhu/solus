import { createHash, randomBytes } from 'crypto'
import { existsSync } from 'fs'
import { link, mkdir, open, unlink } from 'fs/promises'
import { basename, dirname, isAbsolute, join } from 'path'
import { z } from 'zod'
import type { AttachmentUploadRequest, AttachmentUploadTokenRequest, AttachmentUploadTokenResult } from '@solus/contracts/rpc'
import {
  MAX_ATTACHMENT_UPLOAD_BYTES,
  MAX_ATTACHMENT_UPLOAD_COUNT,
} from '@solus/contracts/rpc'
import type { IpcContext } from '@solus/contracts/types'
import { MAX_VIDEO_UPLOAD_BYTES, VIDEO_FILE_EXTENSIONS, videoMimeType } from '@solus/contracts/video'
import { dataDir } from '../../platform/paths'
import type { SolusServer } from '../server'
import { getAssetSigningSecret, readSignedToken, signToken } from '../signed-token'

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

function assertAttachmentMime(mime: string): void {
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

async function attachmentUploadPath(
  ctx: IpcContext,
  name: string,
  mime: string,
  deps: AttachmentHandlerDeps,
): Promise<string> {
  const bucketId = uploadBucketId(ctx)
  if (!bucketId) throw new Error('A conversation is required to upload an attachment.')
  const root = deps.attachmentsDir ?? join(dataDir(), 'attachments')
  const bucketDir = join(root, uploadFolderName(bucketId))
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
async function reserveAttachmentSlot(bucketDir: string): Promise<() => Promise<void>> {
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

/** Decode and persist one attachment on the session's owning host. */
export async function writeAttachmentUpload(
  ctx: IpcContext,
  request: AttachmentUploadRequest,
  deps: AttachmentHandlerDeps = {},
): Promise<string> {
  const buffer = decodeAttachmentDataUrl(request)
  const filePath = await attachmentUploadPath(ctx, request.name, request.mime, deps)
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

/** How long a client has to start a streamed upload after asking for it. */
export const ATTACHMENT_UPLOAD_TOKEN_TTL_MS = 10 * 60 * 1000

interface AttachmentUploadTokenPayload {
  /** Separates this capability from a signed asset read, which has no `kind`. */
  kind: 'upload'
  path: string
  size: number
  mime: string
  expiresAt: number
}

const attachmentUploadTokenPayloadSchema = z
  .object({
    kind: z.literal('upload'),
    path: z.string(),
    size: z.number().int().positive(),
    mime: z.string(),
    expiresAt: z.number().int(),
  })
  .strict()

/**
 * Name an upload and sign a capability for exactly `size` bytes. Reserve its
 * slot only when bytes arrive, so cancelled or expired tokens do not exhaust
 * the conversation's attachment limit.
 */
export async function createAttachmentUploadToken(
  ctx: IpcContext,
  request: AttachmentUploadTokenRequest,
  deps: AttachmentHandlerDeps & { secret?: Buffer; now?: number } = {},
): Promise<AttachmentUploadTokenResult> {
  assertAttachmentMime(request.mime)
  if (!Number.isSafeInteger(request.size) || request.size <= 0) throw new Error('The attachment is empty.')
  const isVideo = videoMimeType({ name: request.name, mimeType: request.mime }) !== null
  const limit = isVideo ? MAX_VIDEO_UPLOAD_BYTES : MAX_ATTACHMENT_UPLOAD_BYTES
  if (request.size > limit) {
    throw new Error(`${isVideo ? 'Videos' : 'Attachments'} can be up to ${limit / 1024 / 1024} MB.`)
  }
  const filePath = await attachmentUploadPath(ctx, request.name, request.mime, deps)
  const expiresAt = (deps.now ?? Date.now()) + ATTACHMENT_UPLOAD_TOKEN_TTL_MS
  const payload: AttachmentUploadTokenPayload = { kind: 'upload', path: filePath, size: request.size, mime: request.mime, expiresAt }
  const token = signToken(payload, deps.secret ?? getAssetSigningSecret())
  return { relativeUrl: `/api/uploads/${token}`, hostPath: filePath, expiresAt }
}

export function verifyAttachmentUploadToken(
  token: string,
  secret: Buffer,
  now = Date.now(),
): AttachmentUploadTokenPayload | null {
  const payload = readSignedToken(token, secret, attachmentUploadTokenPayloadSchema)
  if (!payload || !isAbsolute(payload.path) || payload.expiresAt <= now) return null
  return payload
}

/**
 * Stream one upload body into the file its token names. The body must be
 * exactly the size the token was minted for. Bytes go to a partial file first,
 * and a hard link moves them into place, which fails when the file exists: a
 * token fills its file once. Any failure removes the partial file.
 */
export async function receiveAttachmentUpload(
  token: string,
  request: { contentLength: string | undefined; body: AsyncIterable<Uint8Array> },
  options: { secret?: Buffer; now?: number } = {},
): Promise<Response> {
  const payload = verifyAttachmentUploadToken(token, options.secret ?? getAssetSigningSecret(), options.now)
  if (!payload) return new Response('Invalid or expired upload URL', { status: 403 })
  if (request.contentLength === undefined || !/^\d+$/.test(request.contentLength) || Number(request.contentLength) !== payload.size) {
    return new Response(`Content-Length must be ${payload.size}`, { status: 400 })
  }
  return writeStreamedAttachment(payload, request.body)
}

async function writeStreamedAttachment(payload: AttachmentUploadTokenPayload, body: AsyncIterable<Uint8Array>): Promise<Response> {
  // A client can lose the success response after the file lands. The token
  // still names the same immutable upload, so its retry succeeds as well.
  if (existsSync(payload.path)) return new Response(null, { status: 204 })

  const partialPath = join(dirname(payload.path), `.${basename(payload.path)}.partial`)
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(partialPath, 'wx', 0o600)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      return new Response('This upload is already in progress', { status: 409 })
    }
    throw error
  }

  let received = 0
  let release: (() => Promise<void>) | undefined
  let completed = false
  try {
    try {
      release = await reserveAttachmentSlot(dirname(payload.path))
    } catch (error) {
      return new Response(error instanceof Error ? error.message : 'Cannot reserve an upload slot', { status: 409 })
    }
    for await (const chunk of body) {
      received += chunk.byteLength
      if (received > payload.size) return new Response('The upload is larger than declared', { status: 413 })
      await handle.writeFile(chunk)
    }
    if (received !== payload.size) return new Response('The upload ended early', { status: 400 })
    await handle.close()
    try {
      await link(partialPath, payload.path)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        return new Response(null, { status: 204 })
      }
      throw error
    }
    completed = true
    return new Response(null, { status: 204 })
  } finally {
    await handle.close().catch(() => {})
    await unlink(partialPath).catch(() => {})
    if (!completed) await release?.()
  }
}

export function registerAttachmentHandlers(server: SolusServer, deps: AttachmentHandlerDeps = {}): void {
  server.register('attachUpload', async (args) => {
    const [ctx, request] = args
    return writeAttachmentUpload(ctx, request, deps)
  })
  server.register('attachUploadToken', async (args) => {
    const [ctx, request] = args
    return createAttachmentUploadToken(ctx, request, deps)
  })
}
