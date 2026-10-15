import { createSolusApiRouter } from './solus-api/router'
import { workspaceCredentialsForHttp } from './solus-api/admission'
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
import { consumePairToken, generatePairToken, getInstallationId, getServerFingerprint, isDeviceRevoked, issueGrantWsTicket, issueGuestWsTicket, issueRunnerWsTicket, issueSessionToken, issueWsTicket, listRevokedDevices, refreshSessionToken, revokeDevice, verifyPairOpenAdminRequest, verifySessionToken, type GrantMembership } from '../admission/auth'
import { listReachableEndpoints } from './endpoints'
import type { TokenVerdict } from '../admission/access-tokens'
import { runnerPrincipalFor, type Principal } from '../admission/principal'
import type { ResolvedLinkShare } from '../sharing/share-manager'
import { SHARE_LINK_UNKNOWN, shareLinkRequestSchema, type ShareLinkTarget } from '@solus/contracts/sharing'
import { hostReachAudience, normalizeDisplayName, tokenAudiences, type AccessTokenClaims, type DelegatedAccessTokenClaims, type PersonAccessTokenClaims } from '@solus/contracts/uplink'
import { RUNNER_OUTBOX_PATH, RUNNER_SESSION_RECORDS_PATH, runnerOutboxRequestSchema, runnerSessionRecordsRequestSchema, type RunnerOutboxRequest, type RunnerOutboxResponse, type RunnerSessionRecordsRequest, type RunnerSessionRecordsResponse } from '../sync/runner-protocol'
import { RUNNER_MIRROR_PATH, runnerMirrorRequestSchema, type RunnerMirrorRequest, type RunnerMirrorResponse } from '../sync/runner-protocol'
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
  /** Verifies an account-plane access token (plans/010-standard-oauth.md) presented at `/auth/ws-ticket` or on a runner route.
   *  Absent on a host that is not linked: tokens are then simply not a credential here. */
  verifyAccessToken?: (token: string) => Promise<TokenVerdict>
  /**
   * A signed-in person was admitted at the ticket door with this token: the host makes
   * the delegations it acts for them with (sync/delegations.ts). Absent where nothing
   * acts for people: a host that is not linked, and the Solus API.
   */
  establishDelegation?: (subjectToken: string, scope: DelegationScope) => Promise<void>
  /** A guest is admitted by the share secret alone, to the one resource it names (host-sharing.md §4.1). */
  resolveShareSecret?: (secret: string) => Promise<ResolvedLinkShare | null>
  /** The Solus API only (host-sharing.md §4.2): the host behind a link, for its guest page to dial first. */
  resolveShareLink?: (secret: string) => Promise<ShareLinkTarget | null>
  /** The workspace service's runner routes (cloud-service-model.md §16); mounted in API mode only, so the routes exist nowhere else. */
  runner?: {
    applyOutbox: (runner: RunnerPrincipal, request: RunnerOutboxRequest) => Promise<RunnerOutboxResponse>
    applySessionRecords: (runner: RunnerPrincipal, request: RunnerSessionRecordsRequest) => Promise<RunnerSessionRecordsResponse>
    /** The mirrored domains (§6): transcript rows and insights. */
    applyMirror: (runner: RunnerPrincipal, request: RunnerMirrorRequest) => Promise<RunnerMirrorResponse>
    /** A work published whole (organization-scope §7). */
  }
  /** The device hub proxy's video routes (docs/plans/native-devices.md, D2). The token is the credential. */
  deviceHub?: { serve(token: string, route: string, signal: AbortSignal): Promise<Response> }
  /** Long-form voice transcription implementation supplied by the host. */
  transcribeAudio?: (samples: Float32Array) => Promise<{ error: string | null; transcript: string | null }>
  /** An integration sign-in's browser callback (docs/plans/mcp-integrations.md §4.3). The flow named by `state` decides whose token it is. */
  completeIntegrationOAuth?: (params: URLSearchParams) => Promise<{ status: 200 | 400 | 500; html: string }>
}

type RunnerPrincipal = Extract<Principal, { kind: 'runner' }>

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
  /** Every route registered, so a server that shares an origin can check who owns each path. */
  routes: readonly { method: string; path: string }[]
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
    allowHeaders: ['authorization', 'content-type', 'if-match', 'if-none-match', 'idempotency-key'],
    exposeHeaders: ['etag', 'location', 'retry-after', 'x-request-id'],
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
  app.use('/auth/ws-ticket', publicCors)
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
  // the health probe, the ticket exchange, signed assets, signed uploads and signed
  // device streams (capabilities minted over the authenticated socket), and the OAuth
  // callbacks, which a sign-in started on this origin returns to and whose `state` names
  // the flow. Pairing is local authorization and has no meaning there; the LAN
  // endpoints, bearer uploads, and the served client are not offered either — a door
  // that does not exist cannot leak.
  app.use('*', async (c, next) => {
    if (!viaTunnel(c)) return next()
    const { pathname } = new URL(c.req.url)
    const offered = pathname.startsWith('/v1/') || pathname === '/health' || pathname === '/auth/ws-ticket' || pathname.startsWith('/api/assets/') || pathname.startsWith('/api/uploads/') || pathname.startsWith('/api/device-hub/') || pathname === '/oauth/integration/callback' || pathname === '/oauth/google/callback'
    return offered ? next() : c.notFound()
  })
  if (opts.solusApi) {
    const spec = JSON.stringify(solusApiOpenApi())
    app.route('/v1', createSolusApiRouter({
      credentials: workspaceCredentialsForHttp(opts), operations: opts.solusApi.operations,
      capabilities: { serviceId: opts.solusApi.serviceId, mode: opts.isApiMode ? 'solus-api' : 'combined-host',
        apiVersion: '1', capabilities: ['tasks', 'works', 'session-records', 'notifications', ...(opts.isApiMode ? ['insights' as const] : [])],
        events: { transport: 'socket.io', relativePath: '/ws', protocolVersion: 1 } },
      openApi: () => spec,
    }))
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
    const health = { ok: true, installationId: getInstallationId(), requireAuth: await authRequiredFor(c) }
    // Name and OS are for the local network's host picker, not for the internet.
    if (viaTunnel(c)) return c.json(health)
    return c.json({ ...health, name: currentName(), os: hostOperatingSystem() })
  })

  app.get('/endpoints', async (c) => c.json({ endpoints: await listReachableEndpoints(currentHost(), currentPort()) }))

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
    const pairToken = body?.pairToken ?? body?.code
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

  // The credential travels only in this header; the socket handshake takes the
  // derived five-minute ticket instead. One door, three key types: a host-minted
  // pairing token, an account-plane access token for this host, or — with no
  // bearer at all — a share secret this host made (docs/plans/host-sharing.md §4.1).
  app.post('/auth/ws-ticket', async (c) => {
    const bearer = readBearer(c)
    let ticket = issueWsTicket(bearer)
    const request = ticket ? null : await readJson(c, wsTicketRequestSchema)
    if (!ticket && !bearer && opts.resolveShareSecret) {
      const outcome = await ticketForShareSecret(request, opts.resolveShareSecret)
      if (outcome.ok) ticket = outcome.ticket
      else log.info('share_secret_rejected', { reason: outcome.reason })
    }
    if (!ticket && bearer && opts.verifyAccessToken) {
      const verdict = await opts.verifyAccessToken(bearer)
      if (!verdict.ok) {
        log.info('access_token_rejected', { reason: verdict.reason })
      } else {
        const outcome = await ticketForGrant(verdict.claims, { workspace: opts.isApiMode ?? false, organizationId: request?.organizationId })
        if (outcome.ok) {
          ticket = outcome.ticket
          // The connection does not wait for the exchange; a turn that needs the delegation waits for it.
          if (opts.establishDelegation) void delegateFromPresentedToken(verdict, bearer, [request?.organizationId], opts.establishDelegation)
        }
        else log.info('access_token_rejected', { reason: outcome.reason })
      }
    }
    if (!ticket) return c.json({ error: 'Unauthorized' }, 401)
    return c.json({ ticket })
  })

  // Where a share link's guest page dials (host-sharing.md §4.2): the Solus API answers
  // the host that runs the session, with its routes; the secret alone asks. A wrong
  // secret learns nothing but "not found".
  if (opts.resolveShareLink) {
    const resolveShareLink = opts.resolveShareLink
    app.post('/auth/share-link', async (c) => {
      const body = await readJson(c, shareLinkRequestSchema)
      const target = body ? await resolveShareLink(body.shareSecret) : null
      // Named, so a page can tell "no such link" from a host's plain 404 on this path.
      if (!target) return c.json({ error: { code: SHARE_LINK_UNKNOWN } }, 404)
      return c.json(target, { headers: { 'cache-control': 'no-store' } })
    })
  }

  // The runner routes (cloud-service-model.md §16): the Solus API only. A host
  // delivers what a person's work produced with that person's delegated token
  // (plans/010-standard-oauth.md): the token names the person and, in `act`, the
  // host acting for them. The body's `hostId` must be that host: a host cannot
  // deliver as another.
  if (opts.isApiMode && opts.runner) {
    const runner = opts.runner
    const admitRunner = async (c: Ctx): Promise<RunnerPrincipal | null> => {
      const bearer = readBearer(c)
      if (!bearer || !opts.verifyAccessToken) return null
      const verdict = await opts.verifyAccessToken(bearer)
      if (!verdict.ok) {
        log.info('runner_token_rejected', { reason: verdict.reason })
        return null
      }
      const { claims } = verdict
      // A runner is a host acting for a person in one organization; the Solus API's own delegations name no host.
      if (!claims.act?.host_id || claims.access !== 'org-member') {
        log.info('runner_token_rejected', { reason: !claims.act ? 'not-delegated' : claims.act.host_id ? 'personal-delegation' : 'no-acting-host' })
        return null
      }
      return runnerPrincipalFor({ hostId: claims.act.host_id, organizationId: claims.organizationId, ownerUserId: claims.sub, expiresAt: claims.exp * 1000 })
    }
    app.post(RUNNER_OUTBOX_PATH, async (c) => {
      const principal = await admitRunner(c)
      if (!principal) return c.json({ error: 'Unauthorized' }, 401)
      const body = await readJson(c, runnerOutboxRequestSchema)
      if (!body) return c.json({ error: 'invalid_request' }, 400)
      if (body.hostId !== principal.hostId) return c.json({ error: 'forbidden' }, 403)
      return c.json(await runner.applyOutbox(principal, body))
    })
    app.post(RUNNER_SESSION_RECORDS_PATH, async (c) => {
      const principal = await admitRunner(c)
      if (!principal) return c.json({ error: 'Unauthorized' }, 401)
      const body = await readJson(c, runnerSessionRecordsRequestSchema)
      if (!body) return c.json({ error: 'invalid_request' }, 400)
      if (body.hostId !== principal.hostId) return c.json({ error: 'forbidden' }, 403)
      return c.json(await runner.applySessionRecords(principal, body))
    })
    app.post(RUNNER_MIRROR_PATH, async (c) => {
      const principal = await admitRunner(c)
      if (!principal) return c.json({ error: 'Unauthorized' }, 401)
      const body = await readJson(c, runnerMirrorRequestSchema)
      if (!body) return c.json({ error: 'invalid_request' }, 400)
      if (body.hostId !== principal.hostId) return c.json({ error: 'forbidden' }, 403)
      return c.json(await runner.applyMirror(principal, body))
    })
  }

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
  return { server, host, port, requestListener, routes: app.routes.map(({ method, path }) => ({ method, path })) }
}

const wsTicketRequestSchema = z.object({
  /** The organization the connection works in. A token that lists organizations admits only one it lists (ADR 0001 §6.4). */
  organizationId: z.string().min(1).max(256).optional(),
  shareSecret: z.string().min(1).max(256).optional(),
  /** A host-admitted guest names itself: the id the page keeps and the name it typed (`guest-link.ts`). */
  guestId: z.string().regex(/^[a-zA-Z0-9_-]{16,64}$/).optional(),
  displayName: z.string().max(80).optional(),
})

type GrantTicketOutcome =
  | { ok: true; ticket: string }
  | { ok: false; reason: 'device-revoked' | 'delegated-token' | 'member-required' | 'organization-not-listed' | 'no-acting-host' }

/**
 * How long one host-admitted visit lasts before the page dials again with the
 * secret. A revoked or regenerated link ends the visit at once through the share
 * change, and every call re-checks the secret's hash, so this clock only bounds
 * a socket nobody revoked.
 */
const GUEST_VISIT_TTL_MS = 12 * 60 * 60 * 1000

type SecretTicketOutcome =
  | { ok: true; ticket: string }
  | { ok: false; reason: 'guest-needs-secret' | 'guest-needs-id' | 'not-shared' }

/**
 * A host admits its own guests (docs/plans/host-sharing.md §4.1): the secret of a
 * link this host made, with no bearer, earns a guest ticket bound to that one
 * resource. The visitor is whoever holds the link; the id and name are theirs to
 * state, and the role is the link's. Nothing about the host is reachable with it
 * beyond its permissions (`GUEST_PERMISSIONS`) and the resource's own role.
 */
export async function ticketForShareSecret(
  body: { shareSecret?: string; guestId?: string; displayName?: string } | null,
  resolveShareSecret: NonNullable<HttpServerOptions['resolveShareSecret']>,
): Promise<SecretTicketOutcome> {
  if (!body?.shareSecret) return { ok: false, reason: 'guest-needs-secret' }
  if (!body.guestId) return { ok: false, reason: 'guest-needs-id' }
  const share = await resolveShareSecret(body.shareSecret)
  if (!share) return { ok: false, reason: 'not-shared' }
  const displayName = normalizeDisplayName(body.displayName) ?? 'Guest'
  return {
    ok: true,
    ticket: issueGuestWsTicket({
      guestId: body.guestId,
      displayName,
      organizationId: share.organizationId,
      share: { resource: share.resource, role: share.role, sharedByUserId: share.sharedByUserId, linkSecretHash: share.linkSecretHash },
      expiresAt: Date.now() + GUEST_VISIT_TTL_MS,
    }),
  }
}

/**
 * The grant door (docs/plans/personal-uplink.md H1; plans/010-standard-oauth.md). An
 * owner's and a member's access token become a grant ticket. A host's delegated
 * token opens the runner routes on the API and nothing else. A guest holds no token:
 * the secret alone admits them, at `ticketForShareSecret`
 * (docs/plans/host-sharing.md §4.1).
 *
 * A person's token lists the organizations it may work in (`organizations`,
 * ADR 0001 §6.4): a member's connection names one of them, and no other is admitted.
 * An owner's token needs none.
 */
export async function ticketForGrant(claims: AccessTokenClaims, options: { workspace?: boolean; organizationId?: string } = {}): Promise<GrantTicketOutcome> {
  if (claims.act) return options.workspace ? runnerTicketFor(claims) : hostReachTicketFor(claims, options.organizationId)
  // The owner's Revoke on the Access tab is this host's own refusal of that client grant.
  if (isDeviceRevoked(claims.grant_id)) return { ok: false, reason: 'device-revoked' }
  const membership = grantMembership(claims, options.organizationId)
  if (membership === 'not-listed') return { ok: false, reason: 'organization-not-listed' }
  if (options.workspace && !membership) return { ok: false, reason: 'member-required' }
  const displayName = normalizeDisplayName(claims.displayName) ?? undefined
  return {
    ok: true,
    ticket: issueGrantWsTicket({ userId: claims.sub, deviceId: claims.grant_id, expiresAt: claims.exp * 1000, membership, displayName }),
  }
}

/**
 * A delegated token on the Solus API's record routes: the person it names, as a member
 * of the one organization it names, with the standing it states. The acting host is
 * its device, so the owner's revocation of that host on the Access tab holds here too.
 */
export function ticketForDelegatedMember(claims: DelegatedAccessTokenClaims): GrantTicketOutcome {
  const deviceId = claims.act.host_id
  if (!deviceId) return { ok: false, reason: 'no-acting-host' }
  if (isDeviceRevoked(deviceId)) return { ok: false, reason: 'device-revoked' }
  if (claims.access !== 'org-member') return { ok: false, reason: 'member-required' }
  const membership = membershipOf(claims, { organizationId: claims.organizationId, organizationRole: claims.organizationRole, teamIds: claims.teamIds })
  return {
    ok: true,
    ticket: issueGrantWsTicket({ userId: claims.sub, deviceId, expiresAt: claims.exp * 1000, membership, displayName: normalizeDisplayName(claims.displayName) ?? undefined }),
  }
}

/**
 * Another host acting for a person here (docs/plans/host-reach.md §3): the verifier
 * let a delegated token in only for this host's reach audience. The person enters
 * with the standing the account plane stated for this host. The acting host is the
 * device, so revoking it on the Access tab holds here too.
 */
function hostReachTicketFor(claims: DelegatedAccessTokenClaims, namedOrganizationId: string | undefined): GrantTicketOutcome {
  if (!tokenAudiences(claims).some((audience) => audience.startsWith(hostReachAudience('')))) return { ok: false, reason: 'delegated-token' }
  const deviceId = claims.act.host_id
  if (!deviceId) return { ok: false, reason: 'no-acting-host' }
  if (isDeviceRevoked(deviceId)) return { ok: false, reason: 'device-revoked' }
  const membership = claims.access === 'org-member'
    ? membershipOf(claims, { organizationId: claims.organizationId, organizationRole: claims.organizationRole, teamIds: claims.teamIds })
    : undefined
  if (namedOrganizationId && membership?.organizationId !== namedOrganizationId) return { ok: false, reason: 'organization-not-listed' }
  const displayName = normalizeDisplayName(claims.displayName) ?? undefined
  return { ok: true, ticket: issueGrantWsTicket({ userId: claims.sub, deviceId, expiresAt: claims.exp * 1000, membership, displayName }) }
}

/** A host acting for a person in one organization: its socket on the Solus API, and nowhere else. A personal delegation names no organization, so it opens nothing there. */
function runnerTicketFor(claims: DelegatedAccessTokenClaims): GrantTicketOutcome {
  if (claims.access !== 'org-member') return { ok: false, reason: 'member-required' }
  if (!claims.act.host_id) return { ok: false, reason: 'no-acting-host' }
  return { ok: true, ticket: issueRunnerWsTicket({ hostId: claims.act.host_id, organizationId: claims.organizationId, ownerUserId: claims.sub, expiresAt: claims.exp * 1000 }) }
}

/**
 * A member's standing in the organization the connection works in; undefined for the
 * owner and anyone else who is not a member here. `not-listed` when the token does not
 * list the organization named, or none is named.
 */
function grantMembership(claims: PersonAccessTokenClaims, namedOrganizationId: string | undefined): GrantMembership | 'not-listed' | undefined {
  if (claims.access !== 'org-member') return undefined
  const listed = claims.organizations?.find((entry) => entry.id === namedOrganizationId)
  if (!listed) return 'not-listed'
  return membershipOf(claims, { organizationId: listed.id, organizationRole: listed.role, teamIds: listed.teamIds })
}

function membershipOf(claims: AccessTokenClaims, standing: Pick<GrantMembership, 'organizationId' | 'organizationRole' | 'teamIds'>): GrantMembership {
  const membership: GrantMembership = {
    ...standing,
    hostKind: claims.hostKind ?? 'personal',
    displayName: normalizeDisplayName(claims.displayName) ?? 'Member',
  }
  if (claims.picture) membership.picture = claims.picture
  if (claims.email) membership.email = claims.email
  return membership
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
