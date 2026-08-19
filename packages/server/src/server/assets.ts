import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { realpath, stat } from 'fs/promises'
import { extname, isAbsolute, join, resolve } from 'path'
import { Readable } from 'stream'
import { z } from 'zod'
import type { AssetCreateUrlResult } from '@solus/contracts/rpc'
import type { IpcContext } from '@solus/contracts/types'
import { dataDir } from '../platform/paths'
import { parseByteRange } from './byte-range'
import { resolvePreviewPath } from './handlers/lib/file-preview'
import { isInsideRoot } from '../paths'

export const ASSET_URL_TTL_MS = 60 * 60 * 1000

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
}

const assetTokenPayloadSchema = z
  .object({
    path: z.string(),
    expiresAt: z.number().int(),
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
    if (!ASSET_MIME_TYPES.has(extname(payload.path).toLowerCase())) return null
    return payload
  } catch {
    return null
  }
}

function rawAllowedRoots(ctx: IpcContext): string[] {
  const roots = [
    ctx.session.gitContext?.worktreePath,
    ctx.session.gitContext?.repoRoot,
    ctx.session.projectPath,
    ctx.session.workingDirectory,
  ]
  return roots.filter((path): path is string => !!path && path !== '~')
}

/** Canonicalize a requested artifact and confine it to this session's checkout. */
export async function createAssetUrl(
  ctx: IpcContext,
  requestedPath: string,
  options: { secret?: Buffer; now?: number; ttlMs?: number } = {},
): Promise<AssetCreateUrlResult> {
  if (!requestedPath) throw new Error('An asset path is required.')
  const roots = rawAllowedRoots(ctx)
  if (roots.length === 0) throw new Error('The session has no project directory.')
  const base = roots[0]
  const resolvedRequest = resolvePreviewPath(requestedPath, base)
  const target = await realpath(resolvedRequest)
  const targetStat = await stat(target)
  if (!targetStat.isFile()) throw new Error('Only files can be served as assets.')
  if (!ASSET_MIME_TYPES.has(extname(target).toLowerCase())) {
    throw new Error('This asset type is not allowed.')
  }

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

  const now = options.now ?? Date.now()
  const expiresAt = now + (options.ttlMs ?? ASSET_URL_TTL_MS)
  const token = mintAssetToken({ path: target, expiresAt }, options.secret ?? getAssetSigningSecret())
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
  const mime = ASSET_MIME_TYPES.get(extname(payload.path).toLowerCase())
  if (!mime) return new Response('Unsupported type', { status: 415 })

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
  }
  if (range) Object.assign(headers, { 'Content-Range': `bytes ${start}-${end}/${fileStat.size}` })
  if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers })
  const stream = createReadStream(payload.path, range ? { start, end } : undefined)
  return new Response(Readable.toWeb(stream), {
    status: range ? 206 : 200,
    headers,
  })
}
