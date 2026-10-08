import { existsSync } from 'fs'
import { link, open, unlink } from 'fs/promises'
import { basename, dirname, isAbsolute, join } from 'path'
import { z } from 'zod'
import type { AttachmentUploadRequest, AttachmentUploadTokenRequest, AttachmentUploadTokenResult } from '@solus/contracts/rpc'
import { MAX_ATTACHMENT_UPLOAD_BYTES } from '@solus/contracts/rpc'
import type { IpcContext } from '@solus/contracts/types'
import { MAX_VIDEO_UPLOAD_BYTES, videoMimeType } from '@solus/contracts/media-types'
import { assertAttachmentMime, attachmentUploadPath, reserveAttachmentSlot, storeAttachment } from '../../data/assets/attachment-store'
import type { SolusServer } from '../server'
import { getAssetSigningSecret, readSignedToken, signToken } from '../../admission/signed-token'

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

function requireBucket(ctx: IpcContext): string {
  const bucketId = uploadBucketId(ctx)
  if (!bucketId) throw new Error('A conversation is required to upload an attachment.')
  return bucketId
}

/** Decode and persist one attachment on the session's owning host. */
export async function writeAttachmentUpload(
  ctx: IpcContext,
  request: AttachmentUploadRequest,
  deps: AttachmentHandlerDeps = {},
): Promise<string> {
  return storeAttachment(requireBucket(ctx), request, deps.attachmentsDir)
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
  const filePath = await attachmentUploadPath(requireBucket(ctx), request.name, request.mime, deps.attachmentsDir)
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
