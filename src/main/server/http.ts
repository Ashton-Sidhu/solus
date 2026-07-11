import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'http'
import { existsSync, statSync, readFileSync, realpathSync } from 'fs'
import { randomBytes } from 'crypto'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { getMimeType } from 'hono/utils/mime'
import { getRequestListener } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import formidable, { type File as FormidableFile } from 'formidable'
import { resolve as pathResolve, relative as pathRelative, isAbsolute, sep } from 'path'
import { hostname, tmpdir } from 'os'
import { claimOwnership, consumePairToken, generatePairToken, getInstallationId, getOwnershipState, getServerFingerprint, isClaimable, issueSessionToken, listRevokedDevices, openClaimWindow, refreshSessionToken, revokeDevice, verifyClaimOpenAdminRequest, verifySessionToken } from './auth'
import { listReachableEndpoints } from './endpoints'
import { createTokenBucketRateLimiter } from './rate-limit'
import { filePathsToAttachments } from './attachment-utils'
import { createLogger } from '../logger'
import { completeGoogleOAuthCallback } from '../google/oauth'
import { listProjects } from '../project-config/projects-manifest'

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
}

/** The Node req/res the @hono/node-server adapter exposes as `c.env`. */
type NodeBindings = { incoming: IncomingMessage; outgoing: ServerResponse }
type Env = { Bindings: NodeBindings }
type Ctx = Context<Env>

/**
 * Builds the HTTP server. Returns a node http.Server that the caller
 * `.listen()`s separately. The WebSocket transport mounts itself at `/ws`
 * on the same server via `http.on('upgrade')`.
 *
 * Routing/CORS/body-parsing/static-serving are handled by Hono; the raw Node
 * request is still reachable via `c.env.incoming` (used by the multipart
 * upload). We keep our own `http.Server` via `getRequestListener` so the WS
 * upgrade and the port-retry/rebind logic in server/index.ts stay unchanged.
 */
export function buildHttpServer(opts: HttpServerOptions = {}): { server: HttpServer; host: string; port: number } {
  const host = opts.host ?? '127.0.0.1'
  const currentHost = () => opts.getHost?.() ?? host
  const port = opts.port ?? 0
  const currentPort = () => opts.getPort?.() ?? port
  const pairRateLimiter = createTokenBucketRateLimiter(10, 60_000)
  const claimRateLimiter = createTokenBucketRateLimiter(10, 60_000)

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
  app.use('/claim', publicCors)
  app.use('/upload', publicCors)
  app.use('/artifact', publicCors)
  app.use('/auth/refresh', publicCors)
  app.use('/auth/pair-token', publicCors)
  app.use('/auth/revoke', publicCors)

  app.onError((err, c) => {
    log.error(`http handler error: ${err}`)
    return c.json({ error: 'internal' }, 500)
  })
  app.notFound((c) => c.json({ error: 'not found' }, 404))

  app.get('/health', (c) => c.json({
    ok: true,
    installationId: getInstallationId(),
    claimable: isClaimable(),
    name: hostname() || 'Solus Server',
  }))

  app.get('/endpoints', (c) => c.json({ endpoints: listReachableEndpoints(currentHost(), currentPort()) }))

  app.get('/oauth/google/callback', async (c) => {
    const result = await completeGoogleOAuthCallback(new URL(c.req.url).searchParams)
    // status is a known 2xx/4xx/5xx literal from completeGoogleOAuthCallback.
    return c.html(result.html, result.status as Parameters<Ctx['html']>[1])
  })

  app.post('/pair', async (c) => {
    if (!pairRateLimiter.allow(clientIp(c))) return c.json({ error: 'Too many pairing attempts' }, 429)
    const body = await readJson(c)
    const pairToken = body?.pairToken ?? body?.code
    const deviceLabel = (body?.deviceLabel as string | undefined)?.slice(0, 64) || 'Unknown device'
    if (!pairToken || typeof pairToken !== 'string') {
      return c.json({ error: 'pairToken or code required' }, 400)
    }
    if (!consumePairToken(pairToken)) {
      return c.json({ error: 'Invalid or expired pair token' }, 401)
    }
    const sessionToken = issueSessionToken(deviceLabel)
    log.info(`pair: issued session for "${deviceLabel}"`)
    return c.json({ sessionToken, installationId: getInstallationId() })
  })

  app.post('/claim', async (c) => {
    if (getOwnershipState() !== 'unclaimed') return c.json({ error: 'Server already claimed' }, 403)
    if (!claimRateLimiter.allow(clientIp(c))) return c.json({ error: 'Too many claim attempts' }, 429)
    const body = await readJson(c)
    const claimToken = body?.claimToken ?? body?.code
    const deviceLabel = (body?.deviceLabel as string | undefined)?.slice(0, 64) || 'Owner device'
    if (!claimToken || typeof claimToken !== 'string') {
      return c.json({ error: 'claimToken or code required' }, 400)
    }

    const result = claimOwnership(claimToken, deviceLabel)
    if (!result.ok) {
      return c.json({ error: result.reason === 'owned' ? 'Server already claimed' : 'Invalid or expired claim code' }, 403)
    }

    log.info(`claim: owner device "${deviceLabel}" claimed server`)
    return c.json(result)
  })

  app.post('/claim/open', (c) => {
    if (!verifyClaimOpenAdminRequest(c.env.incoming.headers)) return c.json({ error: 'Unauthorized' }, 401)
    const claimWindow = openClaimWindow()
    if (!claimWindow) return c.json({ error: 'Server already claimed' }, 403)
    log.info('claim: reopened local admin claim window')
    return c.json({
      code: claimWindow.code,
      expiresAt: claimWindow.expiresAt,
      fingerprint: getServerFingerprint(),
      installationId: getInstallationId(),
      endpoints: listReachableEndpoints(currentHost(), currentPort()),
    })
  })

  app.post('/upload', async (c) => {
    if (!verifySessionToken(readBearer(c))) return c.json({ error: 'Unauthorized' }, 401)
    try {
      const filePaths = await receiveMultipart(c.env.incoming)
      return c.json({ attachments: filePathsToAttachments(filePaths) })
    } catch (err) {
      log.error(`upload error: ${err}`)
      return c.json({ error: 'upload failed' }, 500)
    }
  })

  app.get('/artifact', async (c) => {
    if (!verifySessionToken(readBearer(c))) return c.json({ error: 'Unauthorized' }, 401)
    const rawPath = c.req.query('p')
    if (!rawPath || !isAbsolute(rawPath)) return c.json({ error: 'absolute path required' }, 400)

    const filePath = await resolveKnownProjectFile(rawPath)
    if (!filePath) return c.json({ error: 'not found' }, 404)

    const stat = statSync(filePath)
    if (!stat.isFile()) return c.json({ error: 'not found' }, 404)

    const type = getMimeType(filePath) ?? 'application/octet-stream'
    return new Response(readFileSync(filePath), {
      status: 200,
      headers: {
        'content-type': type,
        'content-length': String(stat.size),
        'content-security-policy': "default-src 'none'; img-src data: *; style-src 'unsafe-inline'",
      },
    })
  })

  // Internal/back-compat route for already-paired clients. The Connections panel
  // normally mints tokens through authenticated RPC.
  app.post('/auth/pair-token', (c) => {
    if (!pairRateLimiter.allow(clientIp(c))) return c.json({ error: 'Too many pairing attempts' }, 429)
    if (!verifySessionToken(readBearer(c))) return c.json({ error: 'Unauthorized' }, 401)
    return c.json(generatePairToken())
  })

  app.post('/auth/refresh', (c) => {
    const refreshed = refreshSessionToken(readBearer(c))
    if (!refreshed) return c.json({ error: 'Unauthorized' }, 401)
    return c.json({ sessionToken: refreshed, installationId: getInstallationId() })
  })

  app.post('/auth/revoke', async (c) => {
    if (!verifySessionToken(readBearer(c))) return c.json({ error: 'Unauthorized' }, 401)
    const body = await readJson(c)
    if (!body?.deviceId) return c.json({ error: 'deviceId required' }, 400)
    revokeDevice(body.deviceId)
    return c.json({ ok: true, revoked: listRevokedDevices() })
  })

  // Static fallback for the bundled client. serveStatic streams the requested
  // file (with traversal protection + range support); the second handler is the
  // SPA fallback that serves index.html for any unmatched client-side route.
  if (opts.staticDir && existsSync(opts.staticDir)) {
    const root = opts.staticDir
    app.get('*', serveStatic({ root }))
    app.get('*', serveStatic({ root, path: 'index.html' }))
  }

  const server = createServer(getRequestListener(app.fetch, { overrideGlobalObjects: false }))
  return { server, host, port }
}

async function readJson(c: Ctx): Promise<any> {
  // c.req.json() throws on an empty/invalid body; callers expect null instead.
  try { return await c.req.json() } catch { return null }
}

function readBearer(c: Ctx): string {
  const header = c.req.header('authorization')
  if (!header || !header.toLowerCase().startsWith('bearer ')) return ''
  return header.slice(7).trim()
}

function clientIp(c: Ctx): string {
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded && forwarded.trim()) return forwarded.split(',')[0].trim()
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
    log.warn(`artifact project-root lookup failed: ${err}`)
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

function isInsideRoot(root: string, target: string): boolean {
  const rel = pathRelative(root, target)
  return rel === '' || (!!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

// Caps for the authenticated /upload endpoint. The server can bind to LAN/tailnet,
// so we bound files/size rather than trusting the client to be well-behaved.
const MAX_UPLOAD_FILES = 20
const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024

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
