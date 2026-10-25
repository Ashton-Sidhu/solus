import { createSolusApiRouter, type SolusApiRouter } from './solus-api/router'
import { organizationMemberFor, workspaceAdmissionFor } from './solus-api/admission'
import type { WorkspaceOperations } from '../data/workspace/operations'
import { solusApiOpenApi } from '@solus/contracts/solus-api/openapi'
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
import { tmpdir } from 'os'
import { z } from 'zod'
import { consumePairToken, generatePairToken, getInstallationId, getServerFingerprint, issueSessionToken, listRevokedDevices, refreshSessionToken, revokeDevice, verifyPairOpenAdminRequest, verifySessionToken } from '../admission/auth'
import { createDoors, type Doors } from '../admission/doors'
import { listReachableEndpoints } from './endpoints'
import type { TokenVerdict } from '../admission/access-tokens'
import type { ResolvedLinkShare } from '../sharing/share-manager'
import type { ShareLinkResolver } from '../sharing/share-link-resolver'
import { SHARE_LINK_UNKNOWN, shareLinkRequestSchema } from '@solus/contracts/sharing'
import { registerRunnerRoutes, type RunnerDeliveryIntake } from './runner-routes'
import { delegateFromPresentedToken, type DelegationScope } from '../sync/delegations'
import { createTokenBucketRateLimiter } from './rate-limit'
import { filePathsToAttachments } from './attachment-utils'
import { createLogger } from '../logger'
import { captureServerEvent } from '../analytics'
import { isInsideRoot } from '../paths'
import { completeGoogleOAuthCallback } from '../google/oauth'
import { ATLASSIAN_CALLBACK_PATH, answerOAuthCallback as answerAtlassianOAuthCallback } from '../atlassian/oauth'
import { listProjects } from '../project-config/projects-manifest'
import { readWav } from '../transcription/wav'
import { MAX_VOICE_WAV_BYTES } from '@solus/contracts/voice-audio'
import { parseByteRange } from '../data/assets/byte-range'
import { serveAssetToken } from '../data/assets/assets'
import { getAssetSigningSecret } from '../admission/signed-token'
import { readGithubMediaToken, serveGithubMedia } from '../providers/github/media'
import { receiveAttachmentUpload } from './handlers/attachment-handlers'
import { hostOperatingSystem } from '../platform/host-operating-system'
import { hostDisplayName } from '../platform/host-display-name'
import { hostIdentity } from '../host/host-identity'

const log = createLogger('main', 'http')

export interface HttpServerOptions {
  solusApi?: { operations: WorkspaceOperations; serviceId: string; signingKey?: Buffer }
  isVerifyingUpdate?: () => boolean
  /** Bind address: defaults to 127.0.0.1 (loopback only). Set 0.0.0.0 for remote access. */
  host?: string
  /** Current bind address when the listener can rebind without rebuilding routes. */
  getHost?: () => string
  /** Current listener port after retry/rebind. */
  getPort?: () => number
  /** Port; 0 lets the OS assign an ephemeral port. */
  port?: number
  /** User-facing name advertised to clients on the local network. */
  name?: () => string
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
  /** A managed machine (docs/plans/managed-hosts.md §1) and the workspace service alike: pairing does not exist, on either listener. */
  pairingDisabled?: boolean
  /** API mode (cloud-service-model.md §15): only a member's token or a host's delegated token is a credential; owners do not exist. */
  isApiMode?: boolean
  /** Verifies an account-plane access token (plans/010-standard-oauth.md) presented in a socket's handshake, as an HTTP bearer, or on a runner route.
   *  Absent on a host that is not linked: tokens are then simply not a credential here. */
  verifyAccessToken?: (token: string) => Promise<TokenVerdict>
  /**
   * A signed-in person was admitted with this token: the host makes
   * the delegations it acts for them with (sync/delegations.ts). Absent where nothing
   * acts for people: a host that is not linked, and the Solus API.
   */
  establishDelegation?: (subjectToken: string, scope: DelegationScope) => Promise<void>
  /** A guest is admitted by the share secret alone, to the one resource it names (host-sharing.md §4.1). */
  resolveShareSecret?: (secret: string) => Promise<ResolvedLinkShare | null>
  /** The Solus API only (instant-share-open.md): what a link opens, as whom, and the host to dial. */
  shareLinks?: ShareLinkResolver
  /** The workspace service's runner routes (cloud-service-model.md §16); mounted in API mode only, so the routes exist nowhere else. */
  runner?: RunnerDeliveryIntake
  /** The device hub proxy's video routes (docs/plans/native-devices.md, D2). The token is the credential. */
  deviceHub?: { serve(token: string, route: string, signal: AbortSignal): Promise<Response> }
  /** Long-form voice transcription implementation supplied by the host. */
  transcribeAudio?: (samples: Float32Array) => Promise<{ error: string | null; transcript: string | null }>
  /** An integration sign-in's browser callback (docs/plans/mcp-integrations.md §4.3). The flow named by `state` decides whose token it is. */
  completeIntegrationOAuth?: (params: URLSearchParams) => Promise<{ status: 200 | 400 | 500; html: string }>
}

/** The Node req/res the @hono/node-server adapter exposes as `c.env`. */
type NodeBindings = { incoming: IncomingMessage; outgoing: ServerResponse }
type Env = { Bindings: NodeBindings }
type Ctx = Context<Env>

const pairRequestSchema = z.object({
  /** The pairing link's token or the 6-digit code typed by hand; absent for a trusted requester. */
  pairToken: z.string().optional(),
  deviceLabel: z.string().optional(),
})

const revokeRequestSchema = z.object({ deviceId: z.string().min(1) })

export interface BuiltHttpServer {
  server: HttpServer
  host: string
  port: number
  /** The same routes, for a second listener that must share them (the tunnel's proxied port). */
  requestListener: RequestListener
  /** Every route registered, so a server that shares an origin can check who owns each path. */
  routes: readonly { method: string; path: string }[]
  /** The `/v1` routes, which also answer a client's socket (`solusApiRequest`); null without a Solus API. */
  solusApiRouter: SolusApiRouter | null
  /** The admission of a credential, for the socket transport's handshake (`admission/doors.ts`). */
  doors: Doors
}

/** Slow clients cannot hold a request open: every listener of these routes uses the same limits. */
export const HTTP_SERVER_TIMEOUTS = { requestTimeout: 30_000, headersTimeout: 15_000 } as const

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
  const currentName = () => opts.name?.() ?? hostDisplayName()
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
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['authorization', 'content-type', 'if-match', 'if-none-match', 'idempotency-key', 'solus-organization'],
    exposeHeaders: ['etag', 'location', 'retry-after', 'x-request-id'],
    // A browser asks again only after this long, so a dial costs no preflight each time (instant-share-open.md).
    maxAge: 7200,
  })
  app.use('/v1/*', publicCors)
  app.use('/health', publicCors)
  app.use('/pair', publicCors)
  app.use('/pair/*', publicCors)
  app.use('/upload', publicCors)
  app.use('/voice/transcribe', publicCors)
  app.use('/artifact', publicCors)
  app.use('/api/assets/*', publicCors)
  app.use('/api/uploads/*', publicCors)
  app.use('/api/device-hub/*', publicCors)
  app.use('/auth/refresh', publicCors)
  app.use('/auth/revoke', publicCors)
  app.use('/runner/*', publicCors)
  // After CORS, so a cross-origin client reads the 503 and its preflight still passes.
  app.use('*', async (c, next) => {
    if (opts.isVerifyingUpdate?.()) return c.json({ error: 'Solus is verifying an update. Try again shortly.' }, 503)
    await next()
  })

  app.onError((err, c) => {
    log.error('http_handler_error', { error: err instanceof Error ? err.message : String(err) })
    return c.json({ error: 'internal' }, 500)
  })
  app.notFound((c) => c.json({ error: 'not found' }, 404))

  const viaTunnel = (c: Ctx): boolean => opts.isTunnelRequest?.(c.env.incoming) ?? false
  // A managed host has no pairing door at all: a grant is the only credential, so
  // the routes answer as if they were never there.
  if (opts.pairingDisabled) {
    app.all('/pair', (c) => c.notFound())
    app.all('/pair/*', (c) => c.notFound())
  }
  // The tunnel is a public URL. Only what a grant-holding client needs exists there:
  // the health probe, signed assets, signed uploads and signed
  // device streams (capabilities minted over the authenticated socket), and the OAuth
  // callbacks, which a sign-in started on this origin returns to and whose `state` names
  // the flow. Pairing is local authorization and has no meaning there; the LAN
  // endpoints, bearer uploads, and the served client are not offered either — a door
  // that does not exist cannot leak.
  app.use('*', async (c, next) => {
    if (!viaTunnel(c)) return next()
    const { pathname } = new URL(c.req.url)
    const offered = pathname.startsWith('/v1/') || pathname === '/health' || pathname.startsWith('/api/assets/') || pathname.startsWith('/api/uploads/') || pathname.startsWith('/api/device-hub/') || pathname === '/oauth/integration/callback' || pathname === '/oauth/google/callback'
    return offered ? next() : c.notFound()
  })
  const establishDelegation = opts.establishDelegation
  const doors = createDoors({
    place: opts.isApiMode ? 'api' : 'host',
    pairingDisabled: opts.pairingDisabled || opts.isApiMode,
    verifyAccessToken: opts.verifyAccessToken,
    resolveShareSecret: opts.resolveShareSecret,
    // The connection does not wait for the exchange; a turn that needs the delegation waits for it.
    onPersonToken: establishDelegation ? (verdict, token, organizationId) => void delegateFromPresentedToken(verdict, token, [organizationId], establishDelegation) : undefined,
  })
  let solusApiRouter: SolusApiRouter | null = null
  if (opts.solusApi) {
    const spec = JSON.stringify(solusApiOpenApi())
    solusApiRouter = createSolusApiRouter({
      admission: workspaceAdmissionFor(opts, doors), operations: opts.solusApi.operations,
      capabilities: { serviceId: opts.solusApi.serviceId, mode: opts.isApiMode ? 'solus-api' : 'combined-host',
        apiVersion: '1', capabilities: ['tasks', 'works', 'session-records', 'notifications', ...(opts.isApiMode ? ['insights' as const] : [])],
        events: { transport: 'socket.io', relativePath: '/ws', protocolVersion: 1 } },
      openApi: () => spec,
    })
    app.route('/v1', solusApiRouter)
  }
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
    // A client sends a nonce before it trusts an `http:` route with a credential (docs/plans/host-routes.md D3).
    const nonce = c.req.query('nonce')
    const installationId = getInstallationId()
    const proof = nonce && nonce.length <= 64 ? { identityKey: hostIdentity().publicKey(), proof: hostIdentity().proveTo(nonce, installationId) } : {}
    const health = { ok: true, installationId, requireAuth: await authRequiredFor(c), ...proof }
    // Name and OS are for the local network's host picker, not for the internet.
    if (viaTunnel(c)) return c.json(health)
    return c.json({ ...health, name: currentName(), os: hostOperatingSystem() })
  })

  app.get('/oauth/google/callback', async (c) => {
    const result = await completeGoogleOAuthCallback(new URL(c.req.url).searchParams)
    return c.html(result.html, result.status)
  })

  if (opts.completeIntegrationOAuth) {
    const completeIntegrationOAuth = opts.completeIntegrationOAuth
    app.get('/oauth/integration/callback', async (c) => {
      const result = await completeIntegrationOAuth(new URL(c.req.url).searchParams)
      return c.html(result.html, result.status)
    })
  }

  // The workspace service's Atlassian callback (cloud-service-model.md §22); a
  // host's sign-in lands on the loopback listener and never reaches this route.
  app.get(ATLASSIAN_CALLBACK_PATH, async (c) => {
    const page = await answerAtlassianOAuthCallback(new URL(c.req.url).searchParams)
    return c.html(page.html, page.status)
  })

  app.post('/pair', async (c) => {
    if (!pairRateLimiter.allow(clientIp(c))) return c.json({ error: 'Too many pairing attempts' }, 429)
    const body = await readJson(c, pairRequestSchema)
    const pairToken = body?.pairToken
    const deviceLabel = body?.deviceLabel?.slice(0, 64) || 'Unknown device'
    // A device the host already trusts by network position (loopback, its
    // tailnet, or the local network when the owner opted in) pairs without a
    // code. It still gets its own session token, so it stays listed and
    // revocable, and keeps working once it leaves that network.
    if (!pairToken) {
      if (await authRequiredFor(c)) return c.json({ error: 'A pairing code is required' }, 401)
    } else if (!consumePairToken(pairToken)) {
      return c.json({ error: 'Invalid or expired pair token' }, 401)
    }
    const { token: sessionToken } = issueSessionToken(deviceLabel)
    log.info('pair_session_issued', { deviceLabel, trusted: !pairToken })
    return c.json({ sessionToken, installationId: getInstallationId(), os: hostOperatingSystem(), identityKey: hostIdentity().publicKey() })
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
    const githubMedia = readGithubMediaToken(token, getAssetSigningSecret())
    if (githubMedia) {
      return serveGithubMedia(githubMedia, { method: c.req.method, range: c.req.header('range'), ifRange: c.req.header('if-range') })
    }
    return serveAssetToken(token, {
      method: c.req.method,
      range: c.req.header('range'),
    })
  }
  app.get('/api/assets/:token', serveSignedAsset)
  app.on('HEAD', '/api/assets/:token', serveSignedAsset)

  // The token is the credential: it names one device, one client, and an expiry.
  if (opts.deviceHub) {
    const deviceHub = opts.deviceHub
    app.get('/api/device-hub/:token/:route', (c) => deviceHub.serve(c.req.param('token'), c.req.param('route'), c.req.raw.signal))
  }

  // The token is the credential: it names one file, its size, and an expiry.
  // The body is read straight off the socket, so a 50 MB video is never buffered.
  app.post('/api/uploads/:token', (c) => receiveAttachmentUpload(c.req.param('token'), {
    contentLength: c.req.header('content-length'),
    body: c.env.incoming,
  }))

  app.post('/auth/refresh', (c) => {
    const refreshed = refreshSessionToken(readBearer(c))
    if (!refreshed) return c.json({ error: 'Unauthorized' }, 401)
    return c.json({ sessionToken: refreshed, installationId: getInstallationId() })
  })

  // What a share link opens and as whom (instant-share-open.md): the secret names the
  // resource; the page's own access token, when it sends one, makes a member of the
  // resource's organization open it as themselves. A wrong secret learns nothing but "not found".
  if (opts.shareLinks) {
    const shareLinks = opts.shareLinks
    app.post('/auth/share-link', async (c) => {
      const body = await readJson(c, shareLinkRequestSchema)
      const bearer = readBearer(c)
      const target = body ? await shareLinks.resolve(body.shareSecret, organizationId => organizationMemberFor(doors, bearer, organizationId)) : null
      // Named, so a page can tell "no such link" from a host's plain 404 on this path.
      if (!target) return c.json({ error: { code: SHARE_LINK_UNKNOWN } }, 404)
      return c.json(target, { headers: { 'cache-control': 'no-store' } })
    })
  }

  registerRunnerRoutes(app, opts)

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
    app.get('*', (c, next) => {
      // A browser navigation can name a project or file with a dot in it.
      // Missing build assets still 404, including requests that accept HTML.
      const isDocument = c.req.header('accept')?.includes('text/html')
        && !c.req.path.startsWith('/assets/')
      return hasFileExtension(c.req.path) && !isDocument ? c.notFound() : next()
    })
    app.get('*', serveStatic({ root, path: 'index.html' }))
  }

  const requestListener = getRequestListener(app.fetch, { overrideGlobalObjects: false })
  const server = createServer(HTTP_SERVER_TIMEOUTS, requestListener)
  return { server, host, port, requestListener, routes: app.routes.map(({ method, path }) => ({ method, path })), solusApiRouter, doors }
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
