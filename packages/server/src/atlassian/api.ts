import { z } from 'zod'
import type { AtlassianProduct } from '@solus/contracts/atlassian'
import { createLogger } from '../logger'
import { currentCredential } from './oauth'

const log = createLogger('main', 'atlassian-api')

/**
 * The one way anything in Solus reaches Atlassian — Jira issues and Confluence
 * pages alike, because they are one site behind one grant.
 *
 * An OAuth grant is spent against `api.atlassian.com/ex/<product>/<cloudId>`
 * rather than the site hostname, which is why `cloudId` is the persisted site
 * identity. Callers never think about the base URL, the header, or expiry:
 * `currentCredential()` refreshes first, and this function builds the rest.
 *
 * What a failure *means* is the caller's, though: the task engine needs an auth
 * marker to freeze a link, the doc layer needs its own unavailable/conflict
 * types. So this door stays provider-neutral and hands each caller the status
 * and the reason through `failure`.
 */
export interface AtlassianRequest {
  product: AtlassianProduct
  /** The site the call is for. A call whose `cloudId` is not the connected
   *  site's is refused rather than silently sent somewhere else — page and
   *  issue ids are per-site, so the wrong site is the wrong document. */
  cloudId: string
  /** Product-relative, e.g. `/rest/api/3/issue/ACME-1`. */
  path: string
  method?: 'GET' | 'POST' | 'PUT'
  query?: Record<string, string>
  /** JSON, or a `FormData` for the attachment endpoints — sent as multipart
   *  with the boundary `fetch` derives, plus the XSRF header Atlassian
   *  requires on every multipart write. */
  body?: unknown
  /** Turn a refusal into this caller's own domain error. Defaults to a plain
   *  `AtlassianApiError`, which is right for a caller with nothing to add. */
  failure?: (failure: AtlassianFailure) => Error
}

/** A refused call, as the caller's error mapper sees it. `401` also covers the
 *  connection preconditions — no grant, wrong site, wrong product — because the
 *  fix for all of them is the same one the caller offers for a rejected token. */
export interface AtlassianFailure {
  status: number
  detail: string
}

class AtlassianApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'AtlassianApiError'
  }
}

interface AtlassianConnectedSite {
  cloudId: string
  siteUrl: string
}

/** The connected site for a product, or null when the grant does not reach it.
 *  Used to bind a project before any ticket exists, and to address the site by
 *  hostname for links people click. */
export async function connectedSite(product: AtlassianProduct): Promise<AtlassianConnectedSite | null> {
  const credential = await currentCredential()
  if (!credential || !credential.products.includes(product)) return null
  return { cloudId: credential.cloudId, siteUrl: credential.siteUrl }
}

/** The hostname for one specific site, or null when that is not the connected
 *  one — a link to somewhere the user is not signed in would only mislead. */
export async function connectedSiteUrl(cloudId: string): Promise<string | null> {
  const credential = await currentCredential()
  return credential && credential.cloudId === cloudId ? credential.siteUrl : null
}

/** A response body nothing reads — a 204 from an issue update or a transition.
 *  Named so a call that ignores its answer says so. */
export const IGNORED_RESPONSE = z.unknown()

/**
 * How many calls this process has open to Atlassian at once.
 *
 * Atlassian rate-limits per user, so parallelism past a handful buys nothing and
 * costs the whole connection a cool-down. Every fan-out in Solus — importing a
 * list of issues, polling several bound scopes — funnels through here, so the
 * limit is set once rather than argued about at each call site.
 */
const MAX_CONCURRENT_REQUESTS = 5
/** The cool-down after a 429 is capped: a server asking for ten minutes should
 *  not silently freeze the task engine for ten minutes. */
const MAX_COOLDOWN_MS = 60_000
const DEFAULT_COOLDOWN_MS = 5_000

let activeRequests = 0
const waiting: (() => void)[] = []
/** When the next call may be sent. Set by a 429 and shared by every caller, so
 *  one refusal pauses the connection instead of each call discovering it. */
let cooldownUntil = 0

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

async function acquireSlot(): Promise<void> {
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    await new Promise<void>((resolve) => waiting.push(resolve))
  }
  activeRequests++
}

function releaseSlot(): void {
  activeRequests--
  waiting.shift()?.()
}

/**
 * Seconds Atlassian asks us to wait. `Retry-After` is the documented header;
 * `X-RateLimit-Reset` is an absolute time some endpoints send instead. Neither
 * is guaranteed, hence a default — waiting a fixed few seconds is always better
 * than retrying into the same wall.
 */
function cooldownFor(response: Response): number {
  const retryAfter = Number(response.headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1_000, MAX_COOLDOWN_MS)
  }
  const reset = Date.parse(response.headers.get('x-ratelimit-reset') ?? '')
  if (Number.isFinite(reset)) {
    return Math.min(Math.max(reset - Date.now(), 0), MAX_COOLDOWN_MS)
  }
  return DEFAULT_COOLDOWN_MS
}

export async function atlassianRequest<Schema extends z.ZodType>(
  request: AtlassianRequest,
  schema: Schema,
): Promise<z.infer<Schema>> {
  const fail = (status: number, detail: string): Error => (
    request.failure?.({ status, detail }) ?? new AtlassianApiError(status, detail)
  )

  const credential = await currentCredential()
  if (!credential) {
    throw fail(401, 'No Atlassian site is connected, or the connection expired.')
  }
  if (credential.cloudId !== request.cloudId) {
    throw fail(401, `This is bound to a different Atlassian site than the connected one (${credential.siteUrl}).`)
  }
  if (!credential.products.includes(request.product)) {
    throw fail(403, `The connected Atlassian site (${credential.siteUrl}) does not grant ${request.product} access.`)
  }

  const url = new URL(`https://api.atlassian.com/ex/${request.product}/${request.cloudId}${request.path}`)
  for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value)

  const headers = new Headers({
    authorization: `Bearer ${credential.accessToken}`,
    accept: 'application/json',
  })
  const multipart = request.body instanceof FormData
  if (multipart) headers.set('x-atlassian-token', 'no-check')
  else if (request.body !== undefined) headers.set('content-type', 'application/json')

  const send = async (): Promise<Response> => {
    const remaining = cooldownUntil - Date.now()
    if (remaining > 0) await sleep(remaining)
    await acquireSlot()
    try {
      return await fetch(url, {
        method: request.method ?? 'GET',
        headers,
        body: request.body === undefined
          ? undefined
          : request.body instanceof FormData ? request.body : JSON.stringify(request.body),
      })
    } finally {
      releaseSlot()
    }
  }

  let response = await send()
  if (response.status === 429) {
    // One retry, after the wait Atlassian asked for. Every other caller waits
    // with us, so the retry meets a budget that has actually recovered. A second
    // 429 is a real refusal and is reported as one rather than retried into.
    const wait = cooldownFor(response)
    cooldownUntil = Math.max(cooldownUntil, Date.now() + wait)
    log.warn('atlassian_rate_limited', {
      product: request.product,
      path: request.path,
      waitMs: wait,
    })
    response = await send()
  }
  if (!response.ok) {
    throw fail(response.status, await describeFailure(response, request))
  }
  // 204 on a transition or a field write: nothing to parse, and the caller
  // re-reads rather than trusting an empty body.
  if (response.status === 204) return schema.parse(undefined)
  return schema.parse(await response.json())
}

/**
 * Jira answers a rejected write with the field-level reason, which is the only
 * useful thing to show a user whose sync just failed. Anything else falls back
 * to the status code.
 */
const jiraErrorPayloadSchema = z.object({
  errorMessages: z.array(z.string()).optional(),
  /** Jira's per-field rejections, e.g. `{ priority: "Field 'priority' cannot be set" }`. */
  errors: z.record(z.string(), z.string()).optional(),
})

/**
 * Confluence uses the same key for a different shape — an array of problems,
 * each with its own title. Reading only Jira's dialect turned Confluence's
 * `Unauthorized; scope does not match` (the exact sentence that diagnoses a
 * classic scope on a v2 endpoint) into a bare status code.
 */
const confluenceErrorPayloadSchema = z.object({
  errors: z.array(z.object({
    title: z.string().optional(),
    detail: z.string().nullish(),
  })),
})

async function describeFailure(response: Response, request: AtlassianRequest): Promise<string> {
  if (response.status === 429) {
    // Named, because "HTTP 429" on a task card tells the user nothing they can
    // act on, and the honest advice is simply to wait.
    return 'Atlassian is rate limiting this connection. Solus will retry shortly.'
  }
  const fallback = `Atlassian refused ${request.method ?? 'GET'} ${request.path} (HTTP ${response.status}).`
  const payload = await response.json().catch(() => null)
  if (payload === null) return fallback

  const confluence = confluenceErrorPayloadSchema.safeParse(payload)
  if (confluence.success) {
    const messages = confluence.data.errors.flatMap((error) => {
      const text = [error.title, error.detail].filter(Boolean).join(' — ')
      return text ? [text] : []
    })
    return messages.length ? messages.join('; ') : fallback
  }

  const jira = jiraErrorPayloadSchema.safeParse(payload)
  if (!jira.success) return fallback

  const messages = [
    ...(jira.data.errorMessages ?? []),
    ...Object.entries(jira.data.errors ?? {}).map(([field, message]) => `${field}: ${message}`),
  ]
  return messages.length ? messages.join('; ') : fallback
}
