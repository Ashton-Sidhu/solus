import { z } from 'zod'
import type { AssetCreateUrlResult } from '@solus/contracts/rpc'
import { githubMediaFetchUrl, githubMediaFileName } from '@solus/contracts/github-media'
import { mediaTypeFor } from '@solus/contracts/media-types'
import { projectScopeOf, type IpcContext } from '@solus/contracts/types'
import { getAssetSigningSecret, readSignedToken, signToken } from '../../admission/signed-token'
import { createLogger } from '../../logger'
import { githubCredentials } from './credentials'

/**
 * Media that a pull request body points at on GitHub, served from this host's
 * own origin through a signed asset URL. Adapted from T3 Code (MIT,
 * pingdotgg/t3code@e2e95a39d, apps/server/src/assets/GitHubMediaFetch.ts).
 *
 * The signed URL is the client's only credential. The host adds its GitHub
 * token when it fetches the bytes, and only on a request to GitHub itself, so
 * the token never reaches the client or the object store a redirect leads to.
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
}

const githubMediaTokenSchema = z.object({
  githubMediaUrl: z.string(),
  expiresAt: z.number().int(),
  scope: z.string().optional(),
}).strict()

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

/** Sign a URL on this host for one GitHub media URL. */
export function createGithubMediaUrl(
  ctx: IpcContext | undefined,
  source: string,
  options: { secret?: Buffer; now?: number; ttlMs?: number } = {},
): AssetCreateUrlResult {
  const githubMediaUrl = githubMediaFetchUrl(source)
  if (!githubMediaUrl) throw new Error('Only media that GitHub hosts can be fetched with the GitHub credential.')
  const expiresAt = (options.now ?? Date.now()) + (options.ttlMs ?? GITHUB_MEDIA_URL_TTL_MS)
  const payload: GithubMediaTokenPayload = { githubMediaUrl, expiresAt }
  const scope = ctx ? projectScopeOf(ctx.session) : undefined
  if (scope) payload.scope = scope
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
  /** The tokens to try in order. An empty list fetches with none, so public media still loads. */
  tokens: (scope: string | undefined) => Promise<string[]>
  now: () => number
}

const DEFAULT_DEPS: GithubMediaFetchDeps = {
  fetch: (input, init) => fetch(input, init),
  tokens: async (scope) => (await githubCredentials().chain('github.com', scope)).map((credential) => credential.token),
  now: () => Date.now(),
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
    if (token !== null && CREDENTIALED_HOSTS.has(new URL(target).hostname.toLowerCase())) {
      headers.set('authorization', `Bearer ${token}`)
    }
    const response = await deps.fetch(target, { method, redirect: 'manual', headers })
    if (response.status < 300 || response.status >= 400) return response
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location || hop >= MAX_REDIRECTS) return null
    const next = new URL(location, target)
    if (next.protocol !== 'https:') return null
    target = next.toString()
  }
}

/** Try each credential in the chain until GitHub accepts one. Null when no hop answered. */
async function fetchWithCredentials(
  deps: GithubMediaFetchDeps,
  payload: GithubMediaTokenPayload,
  method: 'GET' | 'HEAD',
  forwarded: Headers,
): Promise<Response | null> {
  const tokens = await deps.tokens(payload.scope)
  const candidates: (string | null)[] = tokens.length > 0 ? tokens : [null]
  let response: Response | null = null
  for (const token of candidates) {
    response = await fetchFollowingRedirects(deps, payload.githubMediaUrl, method, forwarded, token).catch(() => null)
    if (!response || !CREDENTIAL_REFUSALS.has(response.status)) return response
    await response.body?.cancel()
  }
  return response
}

/** The media type to serve, or null for anything that is not a picture or a recording. */
function mediaContentType(response: Response, githubMediaUrl: string): string | null {
  const upstreamType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
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
  const response = await fetchWithCredentials(deps, payload, request.method, forwarded)
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
  return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers })
}
