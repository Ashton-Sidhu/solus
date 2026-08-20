import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { mkdir, realpath, rename, stat, unlink, writeFile } from 'fs/promises'
import { basename, extname, isAbsolute, join, resolve } from 'path'
import { Readable } from 'stream'
import { z } from 'zod'
import {
  MAX_ATTACHMENT_UPLOAD_BYTES,
  type AssetCreateUrlRequest,
  type AssetCreateUrlResult,
  type AssetUploadRequest,
  type AssetUploadResult,
} from '@solus/contracts/rpc'
import type { IpcContext } from '@solus/contracts/types'
import { dataDir } from '../platform/paths'
import { parseByteRange } from './byte-range'
import { resolvePreviewPath } from './handlers/lib/file-preview'
import { isInsideRoot } from '../paths'

export const ASSET_URL_TTL_MS = 60 * 60 * 1000

const ASSET_ID = /^[a-f0-9]{64}\.[a-z0-9][a-z0-9+_-]{0,15}$/
const IMAGE_EXTENSION = new Map<string, string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
])

const RASTER_MIME_BY_EXTENSION = new Map<string, string>([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
])

export const ASSET_MIME_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.pdf', 'application/pdf'],
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

let cachedSecret: { path: string; value: Buffer } | null = null

/** One random asset-capability secret per host data directory. */
export function getAssetSigningSecret(): Buffer {
  const stateDir = join(dataDir(), 'state')
  const secretPath = join(stateDir, 'asset-signing-secret')
  if (cachedSecret?.path === secretPath) return cachedSecret.value
  mkdirSync(stateDir, { recursive: true })

  let value: Buffer
  if (existsSync(secretPath)) {
    value = Buffer.from(readFileSync(secretPath, 'utf8').trim(), 'hex')
  } else {
    value = randomBytes(32)
    try {
      writeFileSync(secretPath, value.toString('hex'), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      value = Buffer.from(readFileSync(secretPath, 'utf8').trim(), 'hex')
    }
  }
  if (value.length !== 32) throw new Error('The host asset signing secret is invalid.')
  cachedSecret = { path: secretPath, value }
  return value
}

export function mintAssetToken(payload: AssetTokenPayload, secret: Buffer): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

export function verifyAssetToken(token: string, secret: Buffer, now = Date.now()): AssetTokenPayload | null {
  const separator = token.lastIndexOf('.')
  if (separator <= 0 || separator === token.length - 1) return null
  const encoded = token.slice(0, separator)
  const signature = token.slice(separator + 1)
  const expected = createHmac('sha256', secret).update(encoded).digest()
  let received: Buffer
  try {
    received = Buffer.from(signature, 'base64url')
  } catch {
    return null
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null

  try {
    const result = assetTokenPayloadSchema.safeParse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')))
    if (!result.success) return null
    const payload = result.data
    if (!isAbsolute(payload.path) || payload.expiresAt <= now) return null
    if (!ASSET_ID.test(basename(payload.path)) && !ASSET_MIME_TYPES.has(extname(payload.path).toLowerCase())) return null
    return payload
  } catch {
    return null
  }
}

function rawAllowedRoots(ctx: IpcContext | undefined): string[] {
  if (!ctx) return []
  const roots = [
    ctx.session.gitContext?.worktreePath,
    ctx.session.gitContext?.repoRoot,
    ctx.session.projectPath,
    ctx.session.workingDirectory,
  ]
  return roots.filter((path): path is string => !!path && path !== '~')
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
  if (RASTER_MIME_BY_EXTENSION.has(candidate)) return 'bin'
  return candidate
}

function storedAssetPath(assetId: string, assetsDir = join(dataDir(), 'assets')): string {
  if (!ASSET_ID.test(assetId)) throw new Error('The asset id is invalid.')
  return join(assetsDir, assetId)
}

/** Store one immutable attachment by its bytes. Repeated uploads share one file. */
export async function writeAssetUpload(
  request: AssetUploadRequest,
  options: { assetsDir?: string } = {},
): Promise<AssetUploadResult> {
  const bytes = decodeUploadedAsset(request)
  const extension = assetExtension(request)
  const id = `${createHash('sha256').update(bytes).digest('hex')}.${extension}`
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
  return { id, uri: `asset://${id}`, mime: request.mime, size: bytes.length }
}

/** Canonicalize a requested artifact and confine it to this session's checkout. */
export async function createAssetUrl(
  ctx: IpcContext | undefined,
  request: AssetCreateUrlRequest,
  options: { secret?: Buffer; now?: number; ttlMs?: number; assetsDir?: string } = {},
): Promise<AssetCreateUrlResult> {
  const requestedPath = request.path
  const assetId = request.assetId
  if (!!requestedPath === !!assetId) throw new Error('Choose one asset source.')

  let target: string
  const roots = rawAllowedRoots(ctx)
  if (assetId) {
    target = await realpath(storedAssetPath(assetId, options.assetsDir))
  } else {
    if (roots.length === 0) throw new Error('The session has no project directory.')
    target = await realpath(resolvePreviewPath(requestedPath!, roots[0]))
  }
  const targetStat = await stat(target)
  if (!targetStat.isFile()) throw new Error('Only files can be served as assets.')
  if (!assetId && !ASSET_MIME_TYPES.has(extname(target).toLowerCase())) {
    throw new Error('This asset type is not allowed.')
  }

  if (!assetId) {
    let isAllowed = false
    for (const rawRoot of roots) {
      try {
        const root = await realpath(resolve(rawRoot))
        if (isInsideRoot(root, target)) {
          isAllowed = true
          break
        }
      } catch {}
    }
    if (!isAllowed) throw new Error('Asset path is outside the session project.')
  }

  const now = options.now ?? Date.now()
  const expiresAt = now + (options.ttlMs ?? ASSET_URL_TTL_MS)
  const token = mintAssetToken(
    { path: target, expiresAt, downloadName: assetId ? request.name : undefined },
    options.secret ?? getAssetSigningSecret(),
  )
  return { relativeUrl: `/api/assets/${token}`, expiresAt }
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
  const extension = extname(payload.path).toLowerCase()
  const isStoredAsset = ASSET_ID.test(basename(payload.path))
  const mime = ASSET_MIME_TYPES.get(extension) ?? 'application/octet-stream'
  if (!isStoredAsset && !ASSET_MIME_TYPES.has(extension)) return new Response('Unsupported type', { status: 415 })
  const isInlineImage = isStoredAsset && RASTER_MIME_BY_EXTENSION.has(extension.slice(1))

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
    'Content-Security-Policy': "default-src 'none'; img-src data: *; style-src 'unsafe-inline'",
    'X-Content-Type-Options': 'nosniff',
  }
  if (isStoredAsset && !isInlineImage) {
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
