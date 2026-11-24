import { existsSync } from 'fs'
import { link, open, readdir, stat, unlink } from 'fs/promises'
import { basename, dirname, isAbsolute, join } from 'path'
import { z } from 'zod'
import type { AttachmentUploadRequest, AttachmentUploadTokenRequest, AttachmentUploadTokenResult } from '@solus/contracts/rpc'
import { MAX_ATTACHMENT_UPLOAD_BYTES } from '@solus/contracts/rpc'
import type { IpcContext } from '@solus/contracts/types'
import { MAX_VIDEO_UPLOAD_BYTES, videoMimeType } from '@solus/contracts/media-types'
import { assertAttachmentMime, assertGuestAttachment, attachmentFileMode, attachmentsRoot, guestImageSignature, attachmentUploadPath, namedUploadPath, storeAttachment } from '../../data/assets/attachment-store'
import type { SolusServer } from '../server'
import { getAssetSigningSecret, readSignedToken, signToken } from '../../admission/signed-token'

export interface AttachmentHandlerDeps {
  attachmentsDir?: string
}

/**
 * Which conversation's folder an upload belongs to. Uploads are stored per
 * conversation, including drafts. A draft keeps its upload folder after it
 * starts a session because the client already has the file's `hostPath`.
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
  /** A guest's upload: the bytes must be the image type the token names (`assertGuestAttachment`). */
  fromGuest?: true
  pending?: true
}

const attachmentUploadTokenPayloadSchema = z
  .object({
    kind: z.literal('upload'),
    path: z.string(),
    size: z.number().int().positive(),
    mime: z.string(),
    expiresAt: z.number().int(),
    fromGuest: z.literal(true).optional(),
    pending: z.literal(true).optional(),
  })
  .strict()

/** Name an upload and sign a capability for exactly `size` bytes. */
export async function createAttachmentUploadToken(
  ctx: IpcContext,
  request: AttachmentUploadTokenRequest,
  deps: AttachmentHandlerDeps & { secret?: Buffer; now?: number; fromGuest?: boolean } = {},
): Promise<AttachmentUploadTokenResult> {
  return createUploadToken(requireBucket(ctx), request, deps)
}

/** The same capability for an upload folder that is not a conversation's, such as a browser page's. */
export async function createUploadToken(
  bucketId: string,
  request: AttachmentUploadTokenRequest,
  deps: AttachmentHandlerDeps & { secret?: Buffer; now?: number; fromGuest?: boolean; keepName?: boolean } = {},
): Promise<AttachmentUploadTokenResult> {
  assertAttachmentMime(request.mime)
  // A guest's image is checked when its bytes arrive; a type it may never send is refused now.
  if (deps.fromGuest) guestImageSignature(request.mime)
  if (!Number.isSafeInteger(request.size) || request.size <= 0) throw new Error('The attachment is empty.')
  const isVideo = videoMimeType({ name: request.name, mimeType: request.mime }) !== null
  const limit = isVideo ? MAX_VIDEO_UPLOAD_BYTES : MAX_ATTACHMENT_UPLOAD_BYTES
  if (request.size > limit) {
    throw new Error(`${isVideo ? 'Videos' : 'Attachments'} can be up to ${limit / 1024 / 1024} MB.`)
  }
  const filePath = deps.keepName
    ? await namedUploadPath(bucketId, request.name, deps.attachmentsDir)
    : await attachmentUploadPath(bucketId, request.name, request.mime, deps.attachmentsDir)
  const expiresAt = (deps.now ?? Date.now()) + ATTACHMENT_UPLOAD_TOKEN_TTL_MS
  const payload: AttachmentUploadTokenPayload = { kind: 'upload', path: filePath, size: request.size, mime: request.mime, expiresAt }
  if (deps.fromGuest) payload.fromGuest = true
  if (request.pending === true && !deps.keepName) payload.pending = true
  const token = signToken(payload, deps.secret ?? getAssetSigningSecret())
  return {
    relativeUrl: `/api/uploads/${token}`, hostPath: filePath, expiresAt,
    ...(payload.pending && { pendingUrl: `/api/uploads/${token}/pending` }),
  }
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
  if (!payload.pending) return writeStreamedAttachment(payload, request.body)
  if (existsSync(payload.path)) return new Response(null, { status: 204 })
  const path = pendingPath(payload)
  if (pendingWrites.has(path)) return new Response(null, { status: 409 })
  const pending = writeStreamedAttachment({ ...payload, path }, request.body)
  pendingWrites.set(path, pending)
  try {
    const response = await pending
    if (response.ok) schedulePendingExpiry(path, payload.expiresAt, options.now ?? Date.now())
    return response
  } finally {
    if (pendingWrites.get(path) === pending) pendingWrites.delete(path)
  }
}

const pendingPrefix = '.pending-upload-'
const pendingWrites = new Map<string, Promise<Response>>()
const pendingExpiry = new Map<string, ReturnType<typeof setTimeout>>()
const pendingPath = (payload: AttachmentUploadTokenPayload) =>
  join(dirname(payload.path), `${pendingPrefix}${payload.expiresAt}-${basename(payload.path)}`)

function schedulePendingExpiry(path: string, expiry: number, now: number): void {
  if (pendingExpiry.has(path)) return
  const timer = setTimeout(() => {
    pendingExpiry.delete(path)
    void removePendingFile(path).catch(() => {})
  }, Math.max(0, expiry - now))
  timer.unref()
  pendingExpiry.set(path, timer)
}

async function removePendingFile(path: string): Promise<void> {
  clearTimeout(pendingExpiry.get(path))
  pendingExpiry.delete(path)
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function recoverPendingUploads(directory: string, now: number): Promise<void> {
  const files = await readdir(directory)
  await Promise.all(files.map(async (leaf) => {
    const expiry = leaf.match(/^\.{1,2}pending-upload-(\d+)-[\da-f]{24}-/)?.[1]
    if (!expiry) return
    const path = join(directory, leaf)
    if (pendingWrites.has(path)) return
    if (Number(expiry) <= now) await removePendingFile(path).catch(() => {})
    else schedulePendingExpiry(path, Number(expiry), now)
  }))
}

/** A pending capability can never remove a file that a prompt has kept. */
export async function managePendingAttachment(
  token: string,
  method: 'HEAD' | 'POST' | 'DELETE',
  options: { secret?: Buffer; now?: number } = {},
): Promise<Response> {
  const payload = verifyAttachmentUploadToken(token, options.secret ?? getAssetSigningSecret(), options.now)
  if (!payload?.pending) return new Response(null, { status: 403 })
  const pending = pendingPath(payload)
  await pendingWrites.get(pending)?.catch(() => {})
  if (method === 'DELETE') {
    await removePendingFile(pending)
    return new Response(null, { status: 204 })
  }
  if (method === 'POST') {
    try {
      await link(pending, payload.path)
    } catch (error) {
      if (!existsSync(payload.path)) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response(null, { status: 404 })
        throw error
      }
    }
    await removePendingFile(pending)
    return new Response(null, { status: 204 })
  }
  const size = await stat(pending).catch(() => stat(payload.path)).then((file) => file.size, () => null)
  return new Response(null, { status: size === payload.size ? 204 : 404 })
}

async function writeStreamedAttachment(payload: AttachmentUploadTokenPayload, body: AsyncIterable<Uint8Array>): Promise<Response> {
  // A client can lose the success response after the file lands. The token
  // still names the same immutable upload, so its retry succeeds as well.
  if (existsSync(payload.path)) return new Response(null, { status: 204 })

  const partialPath = join(dirname(payload.path), `.${basename(payload.path)}.partial`)
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(partialPath, 'wx', attachmentFileMode())
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      return new Response('This upload is already in progress', { status: 409 })
    }
    throw error
  }

  let received = 0
  const head = new Uint8Array(12)
  try {
    for await (const chunk of body) {
      if (received < head.length) head.set(chunk.subarray(0, head.length - received), received)
      received += chunk.byteLength
      if (received > payload.size) return new Response('The upload is larger than declared', { status: 413 })
      await handle.writeFile(chunk)
    }
    if (received !== payload.size) return new Response('The upload ended early', { status: 400 })
    const refused = guestRefusal(payload, head)
    if (refused) return refused
    await handle.close()
    try {
      await link(partialPath, payload.path)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        return new Response(null, { status: 204 })
      }
      throw error
    }
    return new Response(null, { status: 204 })
  } finally {
    await handle.close().catch(() => {})
    await unlink(partialPath).catch(() => {})
  }
}

export function registerAttachmentHandlers(server: SolusServer, deps: AttachmentHandlerDeps = {}): void {
  const root = deps.attachmentsDir ?? attachmentsRoot()
  void readdir(root, { withFileTypes: true }).then(async (entries) => {
    const now = Date.now()
    for (const entry of entries) {
      if (entry.isDirectory()) await recoverPendingUploads(join(root, entry.name), now).catch(() => {})
    }
  }).catch(() => {})
  server.register('attachUpload', async (args, handlerCtx) => {
    const [ctx, request] = args
    if (handlerCtx.principal.kind === 'guest') assertGuestAttachment(request.mime, dataUrlHead(request.dataUrl))
    return writeAttachmentUpload(ctx, request, deps)
  })
  server.register('attachUploadToken', async (args, handlerCtx) => {
    const [ctx, request] = args
    return createAttachmentUploadToken(ctx, request, { ...deps, fromGuest: handlerCtx.principal.kind === 'guest' })
  })
}

/** A guest's upload whose bytes are not the image type its token names; null when it may land. */
function guestRefusal(payload: AttachmentUploadTokenPayload, head: Uint8Array): Response | null {
  if (!payload.fromGuest) return null
  try {
    assertGuestAttachment(payload.mime, head)
    return null
  } catch (error) {
    return new Response(error instanceof Error ? error.message : 'This file is refused', { status: 415 })
  }
}

/** The first bytes of a base64 data URL, enough for `assertGuestAttachment`. */
function dataUrlHead(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',')
  return new Uint8Array(Buffer.from(dataUrl.slice(comma + 1, comma + 1 + 24), 'base64'))
}

