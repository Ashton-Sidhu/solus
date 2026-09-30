import { createHash, randomBytes } from 'crypto'
import { createReadStream, existsSync } from 'fs'
import { mkdir, realpath, rename, stat, unlink, writeFile } from 'fs/promises'
import { basename, extname, isAbsolute, join } from 'path'
import { Readable } from 'stream'
import { z } from 'zod'
import {
  MAX_ATTACHMENT_UPLOAD_BYTES,
  type AssetCreateUrlRequest,
  type AssetCreateUrlResult,
  type AssetFindUrlRequest,
  type AssetFindUrlResult,
  type AssetUploadRequest,
  type AssetUploadResult,
} from '@solus/contracts/rpc'
import type { IpcContext } from '@solus/contracts/types'
import { isRasterImage, mediaTypeFor } from '@solus/contracts/media-types'
import { dataDir } from '../../platform/paths'
import { ASSET_ID, storedAssetPath } from './asset-paths'
import { parseByteRange } from './byte-range'
import { projectRootForRequest, resolvePreviewPath } from '../../files/file-preview'
import { getAssetSigningSecret, readSignedToken, signToken } from '../../admission/signed-token'

export const ASSET_URL_TTL_MS = 60 * 60 * 1000
/** Bounds the file-system work one `assetFindUrl` request can ask for. */
const MAX_ASSET_FIND_CANDIDATES = 16

const IMAGE_EXTENSION = new Map<string, string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
])


interface AssetTokenPayload {
  path: string
  expiresAt: number
  downloadName?: string
}

const assetTokenPayloadSchema = z
  .object({
    path: z.string(),
    expiresAt: z.number().int(),
    downloadName: z.string().optional(),
  })
  .strict()

export function verifyAssetToken(token: string, secret: Buffer, now = Date.now()): AssetTokenPayload | null {
  const payload = readSignedToken(token, secret, assetTokenPayloadSchema)
  if (!payload) return null
  if (!isAbsolute(payload.path) || payload.expiresAt <= now) return null
  if (!ASSET_ID.test(basename(payload.path)) && !mediaTypeFor(payload.path)) return null
  return payload
}

function decodeUploadedAsset(request: AssetUploadRequest): Buffer {
  if (!/^[a-z0-9][a-z0-9!#$&^_.+/-]{0,126}$/i.test(request.mime)) {
    throw new Error('The attachment MIME type is invalid.')
  }
  const match = request.dataUrl.match(/^data:([^;,]+);base64,([a-zA-Z0-9+/]*={0,2})$/)
  if (!match || match[1].toLowerCase() !== request.mime.toLowerCase()) {
    throw new Error('The attachment data is invalid.')
  }
  const encoded = match[2]
  if (encoded.length > Math.ceil(MAX_ATTACHMENT_UPLOAD_BYTES / 3) * 4) {
    throw new Error('Attachments can be up to 10 MB.')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length > MAX_ATTACHMENT_UPLOAD_BYTES) throw new Error('Attachments can be up to 10 MB.')

  if (IMAGE_EXTENSION.has(request.mime)) {
    const valid =
      (request.mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
      (request.mime === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) ||
      (request.mime === 'image/gif' && (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a')) ||
      (request.mime === 'image/webp' && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP')
    if (!valid) throw new Error('The image does not match its file type.')
  }
  return bytes
}

function assetExtension(request: AssetUploadRequest): string {
  const imageExtension = IMAGE_EXTENSION.get(request.mime)
  if (imageExtension) return imageExtension
  const candidate = extname(basename(request.name)).slice(1).toLowerCase()
  if (!/^[a-z0-9][a-z0-9+_-]{0,15}$/.test(candidate)) return 'bin'
  if (isRasterImage(`asset.${candidate}`)) return 'bin'
  return candidate
}

/** Store one immutable attachment by its bytes. Repeated uploads share one file. */
export async function writeAssetUpload(
  request: AssetUploadRequest,
  options: { assetsDir?: string } = {},
): Promise<AssetUploadResult> {
  const stored = await writeAssetBytes(decodeUploadedAsset(request), assetExtension(request), options)
  return { ...stored, mime: request.mime }
}

/**
 * Store bytes the host produced itself (a browser recording) under their
 * content address. The caller vouches for the bytes, so the extension decides
 * how the asset is served: `mp4` plays inline, an unknown one downloads.
 */
export async function writeAssetBytes(
  bytes: Buffer,
  extension: string,
  options: { assetsDir?: string } = {},
): Promise<AssetUploadResult> {
  const id = `${createHash('sha256').update(bytes).digest('hex')}.${extension}`
  if (!ASSET_ID.test(id)) throw new Error('The asset extension is invalid.')
  const root = options.assetsDir ?? join(dataDir(), 'assets')
  const target = join(root, id)
  await mkdir(root, { recursive: true })
  if (!existsSync(target)) {
    const temporary = join(root, `.${id}.${randomBytes(6).toString('hex')}.tmp`)
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
      try {
        await rename(temporary, target)
      } catch (error) {
        // Another upload of the same bytes may win between existsSync and
        // rename. Its content is identical by construction.
        if (!existsSync(target)) throw error
      }
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }
  const mime = mediaTypeFor(id)?.mime ?? 'application/octet-stream'
  return { id, uri: `asset://${id}`, mime, size: bytes.length }
}

/**
 * Sign a short-lived URL for one media file on this host, or one stored asset.
 * A path may name any media file the host can read: every caller already reads
 * host files over `readProjectFile`, and a guest cannot call this at all. Only a
 * relative path needs the session, which it resolves against.
 */
export async function createAssetUrl(
  ctx: IpcContext | undefined,
  request: AssetCreateUrlRequest,
  options: { secret?: Buffer; now?: number; ttlMs?: number; assetsDir?: string } = {},
): Promise<AssetCreateUrlResult> {
  const requestedPath = request.path
  const assetId = request.assetId
  if (!!requestedPath === !!assetId) throw new Error('Choose one asset source.')

  let target: string
  if (assetId) {
    target = await realpath(storedAssetPath(assetId, options.assetsDir))
  } else {
    const root = ctx ? projectRootForRequest(ctx) : null
    if (!isAbsolute(requestedPath!) && !requestedPath!.startsWith('~') && !root) {
      throw new Error('The session has no project directory.')
    }
    target = await realpath(resolvePreviewPath(requestedPath!, root ?? undefined))
  }
  const targetStat = await stat(target)
  if (!targetStat.isFile()) throw new Error('Only files can be served as assets.')
  if (!assetId && !mediaTypeFor(target)) {
    throw new Error('This asset type is not allowed.')
  }

  const now = options.now ?? Date.now()
  const expiresAt = now + (options.ttlMs ?? ASSET_URL_TTL_MS)
  const payload: AssetTokenPayload = { path: target, expiresAt, downloadName: assetId ? request.name : undefined }
  const token = signToken(payload, options.secret ?? getAssetSigningSecret())
  return { relativeUrl: `/api/assets/${token}`, expiresAt }
}

/** Serve the first candidate that `createAssetUrl` accepts, in one round trip.
 *  A client probing conventional locations (a project favicon) would otherwise
 *  pay one host request per miss. */
export async function findAssetUrl(
  ctx: IpcContext | undefined,
  request: AssetFindUrlRequest,
  options: Parameters<typeof createAssetUrl>[2] = {},
): Promise<AssetFindUrlResult | null> {
  for (const path of request.paths.slice(0, MAX_ASSET_FIND_CANDIDATES)) {
    try {
      return { ...(await createAssetUrl(ctx, { path }, options)), path }
    } catch {}
  }
  return null
}

/** Verify an asset capability and stream its file without session cookies. */
export async function serveAssetToken(
  token: string,
  request: { method: string; range?: string },
  options: { secret?: Buffer; now?: number } = {},
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
  }
  const payload = verifyAssetToken(token, options.secret ?? getAssetSigningSecret(), options.now)
  if (!payload) return new Response('Invalid or expired asset URL', { status: 403 })

  let fileStat
  try {
    fileStat = await stat(payload.path)
  } catch {
    return new Response('Not found', { status: 404 })
  }
  if (!fileStat.isFile()) return new Response('Not found', { status: 404 })
  const isStoredAsset = ASSET_ID.test(basename(payload.path))
  const mediaType = mediaTypeFor(payload.path)
  const mime = mediaType?.mime ?? 'application/octet-stream'
  if (!isStoredAsset && !mediaType) return new Response('Unsupported type', { status: 415 })
  // A stored video plays in place like a stored image shows. Every other stored
  // asset downloads, because its bytes were never checked against its type.
  const isInline = isStoredAsset && (isRasterImage(payload.path) || mediaType?.kind === 'video')

  const range = parseByteRange(request.range, fileStat.size)
  if (request.range && !range) {
    return new Response(null, {
      status: 416,
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${fileStat.size}` },
    })
  }
  const start = range?.start ?? 0
  const end = range?.end ?? fileStat.size - 1
  const headers = {
    'Content-Type': mime,
    'Content-Length': String(range ? end - start + 1 : fileStat.size),
    'Accept-Ranges': 'bytes',
    // `media-src 'self'`: a video opened on its own is a media document that
    // loads this same URL.
    'Content-Security-Policy': "default-src 'none'; img-src data: *; media-src 'self' *; style-src 'unsafe-inline'",
    'X-Content-Type-Options': 'nosniff',
  }
  if (isStoredAsset && !isInline) {
    const safeName = (payload.downloadName || basename(payload.path)).replace(/["\\\r\n]/g, '_')
    Object.assign(headers, { 'Content-Disposition': `attachment; filename="${safeName}"` })
  }
  if (range) Object.assign(headers, { 'Content-Range': `bytes ${start}-${end}/${fileStat.size}` })
  if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers })
  const stream = createReadStream(payload.path, range ? { start, end } : undefined)
  return new Response(Readable.toWeb(stream), {
    status: range ? 206 : 200,
    headers,
  })
}
