import { z } from 'zod'
import { solusApiOperations, type SolusApiOperation } from './operations'
import { solusApiMethodSchema, solusApiRequestHeaders, solusApiResponseOf, type SolusApiRequest, type SolusApiResponse } from './request'
import { CLIENT_SOLUS_API_SCOPES, workspaceAuthSessionSchema, workspaceErrorSchema, type SolusApiScope, type WorkspaceAuthSession, type WorkspaceError } from './schemas'

type Operations = typeof solusApiOperations
type ResponseFor<K extends SolusApiOperation> = Operations[K] extends { response: z.ZodType<infer T> } ? T : void
type BodyFor<K extends SolusApiOperation> = Operations[K] extends { body: z.ZodType<infer T> } ? T : never
type RequestInput<K extends SolusApiOperation> = {
  id?: string; query?: z.input<Operations[K]['query']>; body?: BodyFor<K>; version?: string; key?: string
  /** A session's link id, `host/owner/repo#number`: the second path parameter of a pull request route. */
  pullRequestId?: string
}

/** How requests reach the API: a client's socket (`solusApiRequest`), or `SolusApiHttp`. */
export interface SolusApiTransport {
  /** The host, organization, and person requests are for; a change refuses the answers still in flight. */
  contextKey(): string
  send(request: SolusApiRequest): Promise<SolusApiResponse>
}

export interface SolusApiHttpOptions {
  baseUrl(): string
  contextKey(): string
  acquireSource(): Promise<string | null>
  /** The organization the credential is for. A source token that lists several organizations admits only the one named. */
  organizationId?(): string | null
  shareSecret?: string
  /** A link guest with no source token states who it is; with `shareSecret`, that is its whole credential (host-sharing.md §9.8). */
  guestIdentity?: { guestId: string; displayName: string }
  /** What the credential may do; a client, the default set; an execution host's agent run, its run's operations. */
  scopes?: SolusApiScope[]
  /** The transport; defaults to the global `fetch`. */
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>
}
export class WorkspaceRequestError extends Error {
  /** Seconds the server asked the caller to wait before it tries again (`Retry-After`). */
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfter?: number) { super(message); this.name = 'WorkspaceRequestError' }
}

const contextChanged = () => new WorkspaceRequestError(409, 'CONTEXT_CHANGED', 'The active organization or host changed. Read the current workspace again.')

/** One client for the Solus API: desktop, web, and mobile send over their socket; an execution host's agent runs and external callers over HTTP. */
export class SolusApiClient {
  constructor(private readonly transport: SolusApiTransport) {}

  async request<K extends SolusApiOperation>(operationId: K, input: RequestInput<K> & { ifNoneMatch: string }): Promise<ResponseFor<K> | undefined>
  async request<K extends SolusApiOperation>(operationId: K, input?: RequestInput<K>): Promise<ResponseFor<K>>
  async request<K extends SolusApiOperation>(operationId: K, input: RequestInput<K> & { ifNoneMatch?: string } = {}): Promise<ResponseFor<K> | undefined> {
    const operation = solusApiOperations[operationId]
    const key = this.transport.contextKey()
    const query = operation.query.parse(input.query ?? {})
    const path = operation.path
      .replace(':pullRequestId', () => encodeURIComponent(input.pullRequestId ?? ''))
      .replace(/:[A-Za-z]+/, () => encodeURIComponent(input.id ?? ''))
    // The origin only lets the URL encode the path and query; the request names the route alone.
    const url = new URL(path, 'http://solus.invalid')
    for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, String(value))
    const response = await this.transport.send({
      method: solusApiMethodSchema.parse(operation.method.toUpperCase()),
      path: url.pathname + url.search,
      ifMatch: input.version === undefined ? undefined : JSON.stringify(input.version),
      ifNoneMatch: input.ifNoneMatch ? JSON.stringify(input.ifNoneMatch) : undefined,
      idempotencyKey: input.key,
      body: 'body' in operation ? JSON.stringify(operation.body.parse(input.body)) : undefined,
    })
    if (this.transport.contextKey() !== key) throw contextChanged()
    if (response.status === 304 && input.ifNoneMatch) return undefined
    if (response.status < 200 || response.status > 299) throw requestError(response)
    const value = 'response' in operation ? operation.response.parse(JSON.parse(response.body)) : undefined
    // SAFETY: The registry associates each operation key with this exact response schema.
    return value as ResponseFor<K>
  }
}

/**
 * The API over HTTP, for a caller with no socket to the host: an execution host's
 * agent runs, the Lab, and external callers. It exchanges its source token for a
 * credential, keeps it until it expires, and exchanges again once when it is refused.
 */
export class SolusApiHttp implements SolusApiTransport {
  private session: { key: string; value: WorkspaceAuthSession } | null = null
  private exchange: { key: string; promise: Promise<WorkspaceAuthSession> } | null = null
  constructor(private readonly options: SolusApiHttpOptions) {}

  contextKey(): string { return JSON.stringify([this.options.baseUrl(), this.options.contextKey()]) }

  async send(request: SolusApiRequest): Promise<SolusApiResponse> {
    const key = this.contextKey()
    const headers = solusApiRequestHeaders(request)
    for (let attempt = 0; ; attempt++) {
      const credential = await this.credential(key)
      this.assertContext(key)
      headers.set('Authorization', 'Bearer ' + credential.accessToken)
      const response = await (this.options.fetchImpl ?? fetch)(new URL('/v1' + request.path, this.options.baseUrl()), { method: request.method, headers, body: request.body, signal: AbortSignal.timeout(30_000) })
      if (response.status !== 401 || attempt > 0) return solusApiResponseOf(response)
      this.session = null
    }
  }

  private assertContext(key: string): void {
    if (this.contextKey() !== key) throw contextChanged()
  }

  private async credential(key: string): Promise<WorkspaceAuthSession> {
    if (this.session?.key === key && Date.parse(this.session.value.expiresAt) > Date.now() + 5_000) return this.session.value
    if (this.exchange?.key === key) return this.exchange.promise
    const promise = (async () => {
      const source = await this.options.acquireSource()
      this.assertContext(key)
      const { shareSecret, guestIdentity } = this.options
      const asGuest = !source && !!shareSecret && !!guestIdentity
      if (!source && !asGuest) throw new WorkspaceRequestError(401, 'UNAUTHENTICATED', 'Sign in or pair with this host.')
      const request: z.input<typeof solusApiOperations.exchangeCredential.body> = { scopes: this.options.scopes ?? CLIENT_SOLUS_API_SCOPES, shareSecret }
      if (asGuest) Object.assign(request, guestIdentity)
      const organizationId = this.options.organizationId?.()
      if (organizationId) request.organizationId = organizationId
      const headers = new Headers({ 'Content-Type': 'application/json' })
      if (source) headers.set('Authorization', 'Bearer ' + source)
      const response = await (this.options.fetchImpl ?? fetch)(new URL('/v1/auth/session', this.options.baseUrl()), {
        method: 'POST', headers,
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw requestError(await solusApiResponseOf(response))
      const value = workspaceAuthSessionSchema.parse(await response.json())
      this.assertContext(key); this.session = { key, value }; return value
    })()
    this.exchange = { key, promise }
    try { return await promise } finally { if (this.exchange?.promise === promise) this.exchange = null }
  }
}

function requestError(response: SolusApiResponse): WorkspaceRequestError {
  const failure = errorOf(response.body)
  const retryAfter = Number(response.retryAfter)
  return new WorkspaceRequestError(response.status, failure?.error.code ?? 'REQUEST_FAILED', failure?.error.message ?? 'The workspace request failed.',
    retryAfter > 0 ? retryAfter : undefined)
}

/** The API's error in a body, or null when the body holds none. */
function errorOf(body: string): WorkspaceError | null {
  try {
    const parsed = workspaceErrorSchema.safeParse(JSON.parse(body))
    return parsed.success ? parsed.data : null
  } catch { return null }
}
