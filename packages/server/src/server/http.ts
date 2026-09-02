import { createServer, type RequestListener, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'http'
import { createReadStream, existsSync, realpathSync } from 'fs'
import { stat as readFileStat } from 'fs/promises'
import { Readable } from 'stream'
import { randomBytes } from 'crypto'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { compress } from 'hono/compress'
import { getMimeType } from 'hono/utils/mime'
import { getRequestListener } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import formidable, { type File as FormidableFile } from 'formidable'
import { resolve as pathResolve, isAbsolute } from 'path'
import { hostname, tmpdir } from 'os'
import { z } from 'zod'
import { consumePairToken, generatePairToken, getInstallationId, getServerFingerprint, isDeviceRevoked, issueGrantWsTicket, issueSessionToken, issueWsTicket, listRevokedDevices, refreshSessionToken, revokeDevice, verifyPairOpenAdminRequest, verifySessionToken } from './auth'
import { listReachableEndpoints } from './endpoints'
import type { GrantVerdict } from './host-grants'
import { createTokenBucketRateLimiter } from './rate-limit'
import { filePathsToAttachments } from './attachment-utils'
import { createLogger } from '../logger'
import { captureServerEvent } from '../analytics'
import { isInsideRoot } from '../paths'
import { completeGoogleOAuthCallback } from '../google/oauth'
import { listProjects } from '../project-config/projects-manifest'
import { readWav } from '../transcription/wav'
import { MAX_VOICE_WAV_BYTES } from '@solus/contracts/voice-audio'
import { parseByteRange } from './byte-range'
import { serveAssetToken } from './assets'
import { hostOperatingSystem } from '../platform/host-operating-system'

const log = createLogger('main', 'http')

export interface HttpServerOptions {
  /** Bind address: defaults to 127.0.0.1 (loopback only). Set 0.0.0.0 for remote access. */
  host?: string
  /** Current bind address when the listener can rebind without rebuilding routes. */
  getHost?: () => string
  /** Current listener port after retry/rebind. */
  getPort?: () => number
  /** Port; 0 lets the OS assign an ephemeral port. */
  port?: number
  /** Path to the prebuilt web client `dist/` directory; if present, mounted at /. */
  staticDir?: string
  /** Whether connections must authenticate; advertised on /health so a served
   *  client knows it can connect without pairing. Defaults to true. */
  requireAuth?: () => boolean
  /** Requester addresses allowed past a require-auth bind without a token
   *  (the machine itself, the host's own tailnet). Untrusted when absent. */
  isTrustedRequester?: (address: string) => Promise<boolean>
  /** True for a request that arrived through the tunnel's proxied listener. It is
   *  loopback on the wire and must never be trusted for it; pairing is not offered there. */
  isTunnelRequest?: (incoming: IncomingMessage) => boolean
  /** Verifies (and consumes) a control-plane grant presented at `/auth/ws-ticket`.
   *  Absent on a host that is not linked: grants are then simply not a credential here. */
  verifyHostGrant?: (grant: string) => Promise<GrantVerdict>
  /** Long-form voice transcription implementation supplied by the host. */
  transcribeAudio?: (samples: Float32Array) => Promise<{ error: string | null; transcript: string | null }>
}

/** The Node req/res the @hono/node-server adapter exposes as `c.env`. */
type NodeBindings = { incoming: IncomingMessage; outgoing: ServerResponse }
type Env = { Bindings: NodeBindings }
type Ctx = Context<Env>

const pairRequestSchema = z.object({
  pairToken: z.string().optional(),
  code: z.string().optional(),
  deviceLabel: z.string().optional(),
})

const revokeRequestSchema = z.object({ deviceId: z.string().min(1) })

export interface BuiltHttpServer {
  server: HttpServer
  host: string
  port: number
  /** The same routes, for a second listener that must share them (the tunnel's proxied port). */
  requestListener: RequestListener
}

/**
 * Builds the HTTP server. Returns a node http.Server that the caller
 * `.listen()`s separately. Engine.IO intercepts `/ws` requests on this server
 * before they reach Hono.
 *
 * Routing/CORS/body-parsing/static-serving are handled by Hono; the raw Node
 * request is still reachable via `c.env.incoming` (used by the multipart
 * upload). We keep our own `http.Server` via `getRequestListener` so the
 * port-retry/rebind logic in server/index.ts stays unchanged.
 */
export function buildHttpServer(opts: HttpServerOptions = {}): BuiltHttpServer {
  const host = opts.host ?? '127.0.0.1'
  const currentHost = () => opts.getHost?.() ?? host
  const port = opts.port ?? 0
  const currentPort = () => opts.getPort?.() ?? port
  const pairRateLimiter = createTokenBucketRateLimiter(10, 60_000)
  let voiceTranscriptionActive = false

  const app = new Hono<Env>()

  // Every route below is authenticated (if at all) by an `Authorization`
  // bearer header, never cookies, so a cross-origin caller can't ride on an
  // implicit credential the way it could with cookie auth — wildcard origin
  // is safe. This also covers the Electron renderer, which is cross-origin
  // from this server (different scheme/host/port) once the multi-client
  // WebSocket transport replaced direct IPC.
  const publicCors = cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['authorization', 'content-type'],
  })
  app.use('/health', publicCors)
  app.use('/pair', publicCors)
  app.use('/pair/*', publicCors)
  app.use('/upload', publicCors)
  app.use('/voice/transcribe', publicCors)
  app.use('/artifact', publicCors)
  app.use('/api/assets/*', publicCors)
  app.use('/auth/refresh', publicCors)
  app.use('/auth/ws-ticket', publicCors)
  app.use('/auth/revoke', publicCors)

  app.onError((err, c) => {
    log.error('http_handler_error', { error: err instanceof Error ? err.message : String(err) })
    return c.json({ error: 'internal' }, 500)
  })
  app.notFound((c) => c.json({ error: 'not found' }, 404))

  const viaTunnel = (c: Ctx): boolean => opts.isTunnelRequest?.(c.env.incoming) ?? false
  // The tunnel is a public URL. Only what a grant-holding client needs exists there:
  // the health probe, the ticket exchange, and signed assets. Pairing is local
  // authorization and has no meaning there; the LAN endpoints, uploads, and the
  // served client are not offered either — a door that does not exist cannot leak.
  app.use('*', async (c, next) => {
    if (!viaTunnel(c)) return next()
    const { pathname } = new URL(c.req.url)
    const offered = pathname === '/health' || pathname === '/auth/ws-ticket' || pathname.startsWith('/api/assets/')
    return offered ? next() : c.notFound()
  })
  /** Auth demanded of this particular caller: the bind policy, relaxed for
   *  trusted requesters (loopback, the host's own tailnet). A tunnel caller is
   *  loopback on the wire and gets no relaxation of any kind. */
  const authRequiredFor = async (c: Ctx): Promise<boolean> => {
    if (viaTunnel(c)) return true
    if (!(opts.requireAuth?.() ?? true)) return false
    if (!opts.isTrustedRequester) return true
    return !(await opts.isTrustedRequester(clientIp(c)))
  }
  const authorized = async (c: Ctx): Promise<boolean> =>
    !!verifySessionToken(readBearer(c)) || !(await authRequiredFor(c))

  app.get('/health', async (c) => {
    const health = { ok: true, installationId: getInstallationId(), requireAuth: await authRequiredFor(c) }
    // Name and OS are for the local network's host picker, not for the internet.
    if (viaTunnel(c)) return c.json(health)
    return c.json({ ...health, name: hostname() || 'Solus Server', os: hostOperatingSystem() })
  })

  app.get('/endpoints', async (c) => c.json({ endpoints: await listReachableEndpoints(currentHost(), currentPort()) }))

  app.get('/oauth/google/callback', async (c) => {
    const result = await completeGoogleOAuthCallback(new URL(c.req.url).searchParams)
    return c.html(result.html, result.status)
  })

  app.post('/pair', async (c) => {
    if (!pairRateLimiter.allow(clientIp(c))) return c.json({ error: 'Too many pairing attempts' }, 429)
    const body = await readJson(c, pairRequestSchema)
    const pairToken = body?.pairToken ?? body?.code
    const deviceLabel = body?.deviceLabel?.slice(0, 64) || 'Unknown device'
    if (!pairToken) {
      return c.json({ error: 'pairToken or code required' }, 400)
    }
    if (!consumePairToken(pairToken)) {
      return c.json({ error: 'Invalid or expired pair token' }, 401)
    }
    const { token: sessionToken } = issueSessionToken(deviceLabel)
    log.info('pair_session_issued', { deviceLabel })
    return c.json({ sessionToken, installationId: getInstallationId(), os: hostOperatingSystem() })
  })

  app.post('/pair/open', async (c) => {
    if (!verifyPairOpenAdminRequest(c.env.incoming.headers)) return c.json({ error: 'Unauthorized' }, 401)
    const pairToken = generatePairToken()
    log.info('pair_token_generated', { code: pairToken.code, expiresInMinutes: 5 })
    captureServerEvent('pair_token_generated', {})
    return c.json({
      token: pairToken.token,
      code: pairToken.code,
      expiresAt: pairToken.expiresAt,
      fingerprint: getServerFingerprint(),
      installationId: getInstallationId(),
      endpoints: await listReachableEndpoints(currentHost(), currentPort()),
    })
  })

  app.post('/upload', async (c) => {
    if (!(await authorized(c))) return c.json({ error: 'Unauthorized' }, 401)
    try {
      const filePaths = await receiveMultipart(c.env.incoming)
      return c.json({ attachments: filePathsToAttachments(filePaths) })
    } catch (err) {
      log.error('upload_failed', { error: err instanceof Error ? err.message : String(err) })
      return c.json({ error: 'upload failed' }, 500)
    }
  })

  app.post('/voice/transcribe', async (c) => {
    if (!(await authorized(c))) return c.json({ error: 'Unauthorized', transcript: null }, 401)
    if (!opts.transcribeAudio) return c.json({ error: 'Voice transcription is unavailable', transcript: null }, 503)

    const declaredLength = Number(c.req.header('content-length') ?? 0)
    if (declaredLength > MAX_VOICE_WAV_BYTES) {
      return c.json({ error: 'Voice recording exceeds the 60 minute limit', transcript: null }, 413)
    }
    // Reject before buffering/decoding. Otherwise concurrent maximum-size
    // requests each allocate a WAV Buffer and Float32 copy even though the
    // single-flight inference worker can consume only one.
    if (voiceTranscriptionActive) {
      return c.json({ error: 'Voice transcription is already in progress', transcript: null }, 429)
    }
    voiceTranscriptionActive = true

    try {
      const wav = await readLimitedBody(c.env.incoming, MAX_VOICE_WAV_BYTES)
      const samples = readWav(wav)
      return c.json(await opts.transcribeAudio(samples))
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return c.json({ error: 'Voice recording exceeds the 60 minute limit', transcript: null }, 413)
      }
      return c.json({
        error: err instanceof Error ? err.message : 'Invalid voice recording',
        transcript: null,
      }, 400)
    } finally {
      voiceTranscriptionActive = false
    }
  })

  app.get('/artifact', async (c) => {
    if (!(await authorized(c))) return c.json({ error: 'Unauthorized' }, 401)
    const rawPath = c.req.query('p')
    if (!rawPath || !isAbsolute(rawPath)) return c.json({ error: 'absolute path required' }, 400)

    const filePath = await resolveKnownProjectFile(rawPath)
    if (!filePath) return c.json({ error: 'not found' }, 404)

    let stat
    try {
      stat = await readFileStat(filePath)
    } catch {
      return c.json({ error: 'not found' }, 404)
    }
    if (!stat.isFile()) return c.json({ error: 'not found' }, 404)

    const requestedRange = c.req.header('range')
    const range = parseByteRange(requestedRange, stat.size)
    if (requestedRange && !range) {
      return new Response(null, {
        status: 416,
        headers: {
          'accept-ranges': 'bytes',
          'content-range': `bytes */${stat.size}`,
        },
      })
    }

    const type = getMimeType(filePath) ?? 'application/octet-stream'
    const start = range?.start ?? 0
    const end = range?.end ?? stat.size - 1
    const fileStream = createReadStream(filePath, range ? { start, end } : undefined)
    const headers = {
      'content-type': type,
      'content-length': String(range ? end - start + 1 : stat.size),
      'accept-ranges': 'bytes',
      'content-security-policy': "default-src 'none'; img-src data: *; style-src 'unsafe-inline'",
    }
    if (range) Object.assign(headers, { 'content-range': `bytes ${start}-${end}/${stat.size}` })
    return new Response(Readable.toWeb(fileStream), {
      status: range ? 206 : 200,
      headers,
    })
  })

  const serveSignedAsset = (c: Ctx) => {
    const token = c.req.param('token')
    if (!token) return new Response('Missing asset token', { status: 400 })
    return serveAssetToken(token, {
      method: c.req.method,
      range: c.req.header('range'),
    })
  }
  app.get('/api/assets/:token', serveSignedAsset)
  app.on('HEAD', '/api/assets/:token', serveSignedAsset)

  app.post('/auth/refresh', (c) => {
    const refreshed = refreshSessionToken(readBearer(c))
    if (!refreshed) return c.json({ error: 'Unauthorized' }, 401)
    return c.json({ sessionToken: refreshed, installationId: getInstallationId() })
  })

  // The long-lived credential travels only in this header; the socket
  // handshake takes the derived five-minute ticket instead. One door, two key
  // types: a host-minted pairing token, or a control-plane grant for this host.
  app.post('/auth/ws-ticket', async (c) => {
    const bearer = readBearer(c)
    let ticket = issueWsTicket(bearer)
    if (!ticket && bearer && opts.verifyHostGrant) {
      const verdict = await opts.verifyHostGrant(bearer)
      if (verdict.ok && isDeviceRevoked(verdict.claims.deviceId)) {
        // The owner revoked this account session on the Access tab: the host's own
        // kill switch, independent of the control plane.
        log.info('host_grant_rejected', { reason: 'device-revoked' })
      } else if (verdict.ok) {
        ticket = issueGrantWsTicket({
          userId: verdict.claims.sub,
          deviceId: verdict.claims.deviceId,
          expiresAt: verdict.claims.exp * 1000,
        })
      } else {
        log.info('host_grant_rejected', { reason: verdict.reason })
      }
    }
    if (!ticket) return c.json({ error: 'Unauthorized' }, 401)
    return c.json({ ticket })
  })

  app.post('/auth/revoke', async (c) => {
    if (!verifySessionToken(readBearer(c))) return c.json({ error: 'Unauthorized' }, 401)
    const body = await readJson(c, revokeRequestSchema)
    if (!body) return c.json({ error: 'deviceId required' }, 400)
    revokeDevice(body.deviceId)
    return c.json({ ok: true, revoked: listRevokedDevices() })
  })

  // Static fallback for the bundled client. serveStatic streams the requested
  // file (with traversal protection + range support); the second handler is the
  // SPA fallback that serves index.html for any unmatched client-side route.
  if (opts.staticDir && existsSync(opts.staticDir)) {
    const root = opts.staticDir
    // Registered after every dynamic/range route, so only the static fallback
    // reaches compression. Hono preserves streaming and skips 206 responses.
    app.use('*', compress())
    app.use('*', setClientCacheHeaders)
    app.get('*', serveStatic({ root }))
    // A file request that reached this point does not exist in the build. It
    // must 404: answering a stale chunk with index.html makes the browser
    // reject HTML as a module ("'text/html' is not a valid JavaScript MIME
    // type") instead of reporting the chunk as gone, which hides an
    // out-of-date tab behind an unrecoverable parse error.
    app.get('*', (c, next) => (hasFileExtension(c.req.path) ? c.notFound() : next()))
    app.get('*', serveStatic({ root, path: 'index.html' }))
  }

  const requestListener = getRequestListener(app.fetch, { overrideGlobalObjects: false })
  const server = createServer(requestListener)
  return { server, host, port, requestListener }
}

/** A request for a build file (`/assets/index-lLoEVyX3.js`), not a client route. */
function hasFileExtension(path: string): boolean {
  const lastSegment = path.slice(path.lastIndexOf('/') + 1)
  return lastSegment.includes('.')
}

/**
 * Vite content-hashes everything under /assets, so those files may be cached
 * forever. Everything else — index.html above all — names those hashes and must
 * be revalidated, or a reload keeps booting the previous build and asking for
 * chunks the current one no longer contains.
 *
 * serveStatic's onFound runs after the response is built, so the header goes on
 * the way out instead.
 */
const setClientCacheHeaders = async (c: Ctx, next: () => Promise<void>): Promise<void> => {
  await next()
  if (c.res.status !== 200 && c.res.status !== 206) return
  c.res.headers.set(
    'cache-control',
    c.req.path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  )
}

async function readJson<T>(c: Ctx, schema: z.ZodType<T>): Promise<T | null> {
  // c.req.json() throws on an empty/invalid body; callers expect null instead.
  try {
    const result = schema.safeParse(await c.req.json())
    return result.success ? result.data : null
  } catch {
    return null
  }
}

function readBearer(c: Ctx): string {
  const header = c.req.header('authorization')
  if (!header || !header.toLowerCase().startsWith('bearer ')) return ''
  return header.slice(7).trim()
}

function clientIp(c: Ctx): string {
  // This server has no trusted-proxy configuration. Treating an arbitrary
  // X-Forwarded-For value as identity lets unauthenticated callers manufacture
  // rate-limit buckets at will.
  return c.env.incoming.socket.remoteAddress || 'unknown'
}

async function resolveKnownProjectFile(rawPath: string): Promise<string | null> {
  let target: string
  try {
    target = realpathSync(pathResolve(rawPath))
  } catch {
    return null
  }

  const projects = await listProjects().catch((err) => {
    log.warn('artifact_project_lookup_failed', { error: err instanceof Error ? err.message : String(err) })
    return []
  })

  for (const project of projects) {
    try {
      const root = realpathSync(project.path)
      if (isInsideRoot(root, target)) return target
    } catch {}
  }

  return null
}

// Caps for the authenticated /upload endpoint. The server can bind to LAN/tailnet,
// so we bound files/size rather than trusting the client to be well-behaved.
const MAX_UPLOAD_FILES = 20
const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024

class BodyTooLargeError extends Error {}

async function readLimitedBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buffer.length
    if (totalBytes > maxBytes) throw new BodyTooLargeError()
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, totalBytes)
}

async function receiveMultipart(req: IncomingMessage): Promise<string[]> {
  const form = formidable({
    uploadDir: tmpdir(),
    keepExtensions: true,
    maxFiles: MAX_UPLOAD_FILES,
    maxFileSize: MAX_UPLOAD_FILE_BYTES,
    // Reproduce the historical on-disk name `solus-upload-<ts>-<rand>-<safeName>`
    // so filePathsToAttachments derives the same display name + extension. The
    // random segment prevents same-millisecond collisions across files in one
    // request (which would otherwise silently overwrite each other).
    filename: (name, ext) => {
      const safeName = `${name}${ext}`.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'upload'
      return `solus-upload-${Date.now()}-${randomBytes(4).toString('hex')}-${safeName}`
    },
  })

  const [, files] = await form.parse(req)
  return Object.values(files)
    .flat()
    .filter((file): file is FormidableFile => !!file)
    .map((file) => file.filepath)
}
