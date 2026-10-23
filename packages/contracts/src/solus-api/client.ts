import { z } from 'zod'
import { solusApiOperations, type SolusApiOperation } from './operations'
import { SOLUS_API_ORGANIZATION_HEADER, solusApiMethodSchema, solusApiRequestHeaders, solusApiResponseOf, type SolusApiRequest, type SolusApiResponse } from './request'
import { workspaceErrorSchema, type WorkspaceError } from './schemas'

type Operations = typeof solusApiOperations
type ResponseFor<K extends SolusApiOperation> = Operations[K] extends { response: z.ZodType<infer T> } ? T : void
type BodyFor<K extends SolusApiOperation> = Operations[K] extends { body: z.ZodType<infer T> } ? T : never
type RequestInput<K extends SolusApiOperation> = {
  id?: string; query?: z.input<Operations[K]['query']>; body?: BodyFor<K>; version?: string; key?: string
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
  /** The bearer each request presents: an access token for the Solus API, a host's delegated token, or a pairing session token. */
  acquireSource(): Promise<string | null>
  /** The organization requests work in. A token that lists several organizations admits only the one named. */
  organizationId?(): string | null
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
    const path = operation.path.replace(/:[A-Za-z]+/, () => encodeURIComponent(input.id ?? ''))
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
 * agent runs, the Lab, and external callers. Each request presents the caller's own
 * token; the server admits it directly (docs/plans/simplify-auth-and-sync.md §4.2).
 */
export class SolusApiHttp implements SolusApiTransport {
  constructor(private readonly options: SolusApiHttpOptions) {}

  contextKey(): string { return JSON.stringify([this.options.baseUrl(), this.options.contextKey()]) }

  async send(request: SolusApiRequest): Promise<SolusApiResponse> {
    const key = this.contextKey()
    const source = await this.options.acquireSource()
    if (this.contextKey() !== key) throw contextChanged()
    if (!source) throw new WorkspaceRequestError(401, 'UNAUTHENTICATED', 'Sign in or pair with this host.')
    const headers = solusApiRequestHeaders(request)
    headers.set('Authorization', 'Bearer ' + source)
    const organizationId = this.options.organizationId?.()
    if (organizationId) headers.set(SOLUS_API_ORGANIZATION_HEADER, organizationId)
    const response = await (this.options.fetchImpl ?? fetch)(new URL('/v1' + request.path, this.options.baseUrl()), { method: request.method, headers, body: request.body, signal: AbortSignal.timeout(30_000) })
    return solusApiResponseOf(response)
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
