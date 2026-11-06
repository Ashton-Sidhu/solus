import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AssetCreateUrlResult } from '@solus/contracts/rpc'
import { GITHUB_REPOSITORY_PATTERN, githubMediaFetchUrl, githubMediaFileName, githubUploadRepository } from '@solus/contracts/github-media'
import { mediaTypeFor } from '@solus/contracts/media-types'
import { projectScopeOf, type IpcContext } from '@solus/contracts/types'
import { getAssetSigningSecret, readSignedToken, signToken } from '../../admission/signed-token'
import { createLogger } from '../../logger'
import { currentPersonKey, withUserScope } from '../../vault/acting-scope'
import { githubCredentials, type GithubCredential } from './credentials'
import { clientFor } from './octokit'
import { githubRateLimitOf } from './rate-limit'
import { runGithubRequest } from './request'

/**
 * Media that a pull request body points at on GitHub, served from this host's
 * own origin through a signed asset URL. Adapted from T3 Code (MIT,
 * pingdotgg/t3code@a09aef328,
 * packages/source-control-github/src/server/gitHubMediaFetch.ts).
 *
 * The signed URL is the client's only credential, and the person who asked for
 * it is the one the host fetches as. The host adds that person's GitHub token
 * when it fetches the bytes, and only on a request to GitHub itself, so the
 * token never reaches the client or the object store a redirect leads to.
 *
 * An organization that enforces SAML SSO answers an upload with its sign-in
 * page. Rendering the upload as Markdown in its repository gives a URL that
 * GitHub signed, which the host fetches with no token.
 */

const log = createLogger('main', 'github-media')

export const GITHUB_MEDIA_URL_TTL_MS = 60 * 60 * 1000

/** The token payload. Its keys differ from every other signed asset payload,
 *  so a token minted for one kind cannot be read as the other. */
interface GithubMediaTokenPayload {
  githubMediaUrl: string
  expiresAt: number
  /** The project the request named, for a credential that a checkout chooses. */
  scope?: string
  /** The person the fetch acts for: null for the host's own work. A request for
   *  an asset carries no identity, so the token says whose GitHub access it uses. */
  personKey: string | null
  /** The pull request's `owner/name`, which can differ from the checkout. */
  repository?: string
}

const githubMediaTokenSchema = z.object({
  githubMediaUrl: z.string(),
  expiresAt: z.number().int(),
  scope: z.string().optional(),
  personKey: z.string().nullable(),
  repository: z.string().optional(),
}).strict()

/** The wire carries an omitted repository as null. */
const repositorySchema = z.string().regex(GITHUB_REPOSITORY_PATTERN).nullish()

/** The hosts the credential is for. A redirect leads to a signed object URL
 *  that authorizes itself, and some object stores refuse a bearer token. */
const CREDENTIALED_HOSTS = new Set(['github.com', 'www.github.com', 'raw.githubusercontent.com', 'media.githubusercontent.com'])
/** GitHub answers an attachment with a redirect to a signed object URL. */
const MAX_REDIRECTS = 3
const FORWARDED_RESPONSE_HEADERS = ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'] as const
/** A pull request embeds pictures and recordings. Nothing else leaves this origin. */
const MEDIA_CONTENT_TYPE = /^(?:image|video|audio)\/[\w!#$&^.+-]+$/i
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
/** A credential GitHub refuses for this media, so the next one in the chain is tried. */
const CREDENTIAL_REFUSALS = new Set([401, 403, 404])
/** The only host a rendered upload may lead to. */
const SIGNED_UPLOAD_HOST = 'private-user-images.githubusercontent.com'
const RENDERED_IMAGE_SOURCE = /<img\b[^>]*\ssrc\s*=\s*(["'])(.*?)\1/giu
/** GitHub's signed upload links last about five minutes. */
const SIGNED_URL_CACHE_TTL_MS = 4 * 60_000
const SIGNED_URL_CACHE_MAX_ENTRIES = 64

/** Sign a URL on this host for one GitHub media URL. */
export function createGithubMediaUrl(
  ctx: IpcContext | undefined,
  source: string,
  options: { repository?: string; secret?: Buffer; now?: number; ttlMs?: number } = {},
): AssetCreateUrlResult {
  const githubMediaUrl = githubMediaFetchUrl(source)
  if (!githubMediaUrl) throw new Error('Only media that GitHub hosts can be fetched with the GitHub credential.')
  const repository = repositorySchema.safeParse(options.repository)
  if (!repository.success) throw new Error('A pull request repository must be owner/name.')
  const expiresAt = (options.now ?? Date.now()) + (options.ttlMs ?? GITHUB_MEDIA_URL_TTL_MS)
  const payload: GithubMediaTokenPayload = { githubMediaUrl, expiresAt, personKey: currentPersonKey() }
  const scope = ctx ? projectScopeOf(ctx.session) : undefined
  if (scope) payload.scope = scope
  if (repository.data) payload.repository = repository.data
  const token = signToken(payload, options.secret ?? getAssetSigningSecret())
  return { relativeUrl: `/api/assets/${token}`, expiresAt }
}

/** The payload of a live GitHub media token, or null for any other token. */
export function readGithubMediaToken(token: string, secret: Buffer, now = Date.now()): GithubMediaTokenPayload | null {
  const payload = readSignedToken(token, secret, githubMediaTokenSchema)
  if (!payload || payload.expiresAt <= now) return null
  // The signature keeps the URL where it was checked; this keeps a rule change
  // from serving a URL that the new rule refuses.
  return githubMediaFetchUrl(payload.githubMediaUrl) === payload.githubMediaUrl ? payload : null
}

export interface GithubMediaFetchDeps {
  fetch: typeof fetch
  /** The credentials to try in order. An empty list fetches with none, so public media still loads. */
  credentials: (scope: string | undefined) => Promise<GithubCredential[]>
  /** GitHub's HTML for `text`, rendered in `repository`. */
  renderMarkdown: (credential: GithubCredential, text: string, repository: string) => Promise<string>
  now: () => number
  /** Signed upload URLs, by account, repository, and upload. */
  signedUrls: Map<string, { url: string; at: number }>
}

const DEFAULT_DEPS: GithubMediaFetchDeps = {
  fetch: (input, init) => fetch(input, init),
  credentials: (scope) => githubCredentials().chain('github.com', scope),
  renderMarkdown: (credential, text, context) => runGithubRequest('renderMarkdown', 'github.com', [clientFor(credential)], async (client) =>
    (await client.rest.markdown.render({ text, mode: 'gfm', context })).data),
  now: () => Date.now(),
  signedUrls: new Map(),
}

/** Only GitHub's own HTTPS origin gets the token: a redirect can name any port. */
function isCredentialedUrl(url: URL): boolean {
  return url.protocol === 'https:' && url.port === '' && CREDENTIALED_HOSTS.has(url.hostname.toLowerCase())
}

/** Follow GitHub's redirects by hand, so the token goes only to GitHub. */
async function fetchFollowingRedirects(
  deps: GithubMediaFetchDeps,
  url: string,
  method: 'GET' | 'HEAD',
  forwarded: Headers,
  token: string | null,
): Promise<Response | null> {
  let target = url
  for (let hop = 0; ; hop++) {
    const headers = new Headers(forwarded)
    // The bytes go straight through, so no encoding layer may change them.
    headers.set('accept-encoding', 'identity')
    if (token !== null && isCredentialedUrl(new URL(target))) {
      headers.set('authorization', `Bearer ${token}`)
    }
    const response = await deps.fetch(target, { method, redirect: 'manual', headers })
    if (response.status < 300 || response.status >= 400) return response
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location || hop >= MAX_REDIRECTS) return null
    const next = new URL(location, target)
    if (next.protocol !== 'https:' || next.username || next.password) return null
    target = next.toString()
  }
}

function contentTypeOf(response: Response): string {
  return response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

/** The URL GitHub signed for an upload, from the HTML it rendered, or null when it left the upload unsigned. */
function signedUrlIn(html: string): string | null {
  for (const match of html.matchAll(RENDERED_IMAGE_SOURCE)) {
    const signed = URL.parse(match[2].replaceAll('&amp;', '&'))
    if (signed?.protocol === 'https:' && signed.hostname === SIGNED_UPLOAD_HOST && signed.port === ''
      && !signed.username && !signed.password && signed.searchParams.get('jwt')) return signed.toString()
  }
  return null
}

/** Render the upload in `repository` as this account. A rate limit is final, as in `runGithubRequest`. */
async function renderSignedUrl(deps: GithubMediaFetchDeps, githubMediaUrl: string, repository: string, credential: GithubCredential): Promise<string | null> {
  try {
    return signedUrlIn(await deps.renderMarkdown(credential, `![](${githubMediaUrl})`, repository))
  } catch (error) {
    if (githubRateLimitOf(error)) throw error
    return null
  }
}

/** A signed URL authorizes itself, so no token goes with it. Always a GET: its signature is for that method. */
function fetchSignedUrl(deps: GithubMediaFetchDeps, url: string, forwarded: Headers): Promise<Response | null> {
  return fetchFollowingRedirects(deps, url, 'GET', forwarded, null)
}

/** Fetch an upload as one account: a live signed URL, else the upload, else a new signed URL. */
async function fetchUpload(
  deps: GithubMediaFetchDeps,
  githubMediaUrl: string,
  repository: string,
  method: 'GET' | 'HEAD',
  forwarded: Headers,
  credential: GithubCredential,
): Promise<Response | null> {
  // A hash, so the map holds no token. Each account has its own entry.
  const account = createHash('sha256').update(credential.token).digest('hex')
  const key = `${account}\0${repository}\0${githubMediaUrl}`
  const cached = deps.signedUrls.get(key)
  const now = deps.now()
  if (cached && now - cached.at < SIGNED_URL_CACHE_TTL_MS) {
    const response = await fetchSignedUrl(deps, cached.url, forwarded)
    if (response && response.status < 400) return response
    deps.signedUrls.delete(key)
    // A signed URL can expire early. Only then is a new one worth rendering.
    if (response?.status !== 403) return response
    await response.body?.cancel()
  } else {
    deps.signedUrls.delete(key)
    const response = await fetchFollowingRedirects(deps, githubMediaUrl, method, forwarded, credential.token)
    if (!response || contentTypeOf(response) !== 'text/html') return response
    await response.body?.cancel()
  }
  const signed = await renderSignedUrl(deps, githubMediaUrl, repository, credential)
  if (!signed) {
    log.warn('github_media_signed_url_unavailable', { repository })
    return new Response(null, { status: 403 })
  }
  const media = await fetchSignedUrl(deps, signed, forwarded)
  if (media && (media.status === 200 || media.status === 206) && MEDIA_CONTENT_TYPE.test(contentTypeOf(media))) {
    if (deps.signedUrls.size >= SIGNED_URL_CACHE_MAX_ENTRIES) {
      const oldest = deps.signedUrls.keys().next().value
      if (oldest !== undefined) deps.signedUrls.delete(oldest)
    }
    deps.signedUrls.set(key, { url: signed, at: now })
  }
  return media
}

/** Try each credential in the chain until GitHub accepts one. Null when no hop answered. */
async function fetchWithCredentials(
  deps: GithubMediaFetchDeps,
  payload: GithubMediaTokenPayload,
  method: 'GET' | 'HEAD',
  forwarded: Headers,
): Promise<Response | null> {
  const credentials = await deps.credentials(payload.scope)
  const candidates: (GithubCredential | null)[] = credentials.length > 0 ? credentials : [null]
  const repository = githubUploadRepository(payload.githubMediaUrl, payload.repository)
  let response: Response | null = null
  for (const credential of candidates) {
    response = await (credential && repository
      ? fetchUpload(deps, payload.githubMediaUrl, repository, method, forwarded, credential)
      : fetchFollowingRedirects(deps, payload.githubMediaUrl, method, forwarded, credential?.token ?? null)
    ).catch(() => null)
    if (!response || !CREDENTIAL_REFUSALS.has(response.status)) return response
    await response.body?.cancel()
  }
  return response
}

/** The media type to serve, or null for anything that is not a picture or a recording. */
function mediaContentType(response: Response, githubMediaUrl: string): string | null {
  const upstreamType = contentTypeOf(response)
  if (MEDIA_CONTENT_TYPE.test(upstreamType)) return upstreamType
  // The raw host labels every committed binary `application/octet-stream`, so
  // the file name decides the type of those.
  const named = mediaTypeFor(githubMediaFileName(githubMediaUrl))?.mime ?? ''
  return MEDIA_CONTENT_TYPE.test(named) ? named : null
}

/**
 * Fetch the media for a verified token and answer it as this origin's own.
 */
export async function serveGithubMedia(
  payload: GithubMediaTokenPayload,
  request: { method: string; range?: string; ifRange?: string },
  deps: GithubMediaFetchDeps = DEFAULT_DEPS,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
  }
  const remainingSeconds = Math.floor((payload.expiresAt - deps.now()) / 1000)
  const headers = new Headers({
    // GitHub never changes the bytes behind an upload URL. A copy must only
    // not outlive the signed URL that granted it.
    'cache-control': remainingSeconds > 0 ? `private, max-age=${remainingSeconds}` : 'private, no-store',
    'x-content-type-options': 'nosniff',
  })
  // Passed on, so a seek in a long video is one range request upstream.
  const forwarded = new Headers()
  if (request.range) forwarded.set('range', request.range)
  if (request.ifRange) forwarded.set('if-range', request.ifRange)
  // An asset request has no acting scope of its own: it acts for the person who signed it.
  const { method } = request
  const response = await withUserScope(payload.personKey, () => fetchWithCredentials(deps, payload, method, forwarded))
  const host = new URL(payload.githubMediaUrl).hostname
  if (!response) {
    log.warn('github_media_fetch_failed', { host })
    return new Response(null, { status: 502, headers })
  }
  // An upstream refusal is the client's answer; only a broken hop is this
  // host's fault. No upstream entity header goes with it: a length with no
  // body holds the connection open.
  if (response.status >= 400) {
    await response.body?.cancel()
    log.warn('github_media_refused', { host, status: response.status })
    return new Response(null, { status: response.status >= 500 ? 502 : response.status, headers })
  }
  const contentType = mediaContentType(response, payload.githubMediaUrl)
  if (!contentType) {
    await response.body?.cancel()
    return new Response(null, { status: 415, headers })
  }
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  headers.set('content-type', contentType)
  // An SVG is a document: no script in a pull request body runs on this origin.
  if (contentType === 'image/svg+xml') headers.set('content-security-policy', SVG_CONTENT_SECURITY_POLICY)
  if (request.method === 'HEAD') await response.body?.cancel()
  return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers })
}
