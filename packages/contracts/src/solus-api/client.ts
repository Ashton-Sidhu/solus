import { z } from 'zod'
import { solusApiOperations, type SolusApiOperation } from './operations'
import { workspaceAuthSessionSchema, workspaceErrorSchema, type SolusApiScope, type WorkspaceAuthSession } from './schemas'

type Operations = typeof solusApiOperations
type ResponseFor<K extends SolusApiOperation> = Operations[K] extends { response: z.ZodType<infer T> } ? T : void
type BodyFor<K extends SolusApiOperation> = Operations[K] extends { body: z.ZodType<infer T> } ? T : never
type RequestInput<K extends SolusApiOperation> = {
  id?: string; query?: z.input<Operations[K]['query']>; body?: BodyFor<K>; version?: string; key?: string
}
export interface SolusApiClientOptions {
  baseUrl(): string
  contextKey(): string
  acquireSource(): Promise<string | null>
  shareSecret?: string
  /** What the credential may do; a client, the default set; an execution host's agent run, its run's operations. */
  scopes?: SolusApiScope[]
  /** The transport; defaults to the global `fetch`. */
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>
}
export class WorkspaceRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = 'WorkspaceRequestError' }
}

/** One client for desktop, web, mobile, external HTTP callers, and an execution host's agent runs. It needs no event socket. */
export class SolusApiClient {
  private session: { key: string; value: WorkspaceAuthSession } | null = null
  private exchange: { key: string; promise: Promise<WorkspaceAuthSession> } | null = null
  constructor(private readonly options: SolusApiClientOptions) {}

  private key(): string { return JSON.stringify([this.options.baseUrl(), this.options.contextKey()]) }
  private assertContext(key: string): void {
    if (this.key() !== key) throw new WorkspaceRequestError(409, 'CONTEXT_CHANGED', 'The active organization or host changed. Read the current workspace again.')
  }
  private async credential(key: string): Promise<WorkspaceAuthSession> {
    if (this.session?.key === key && Date.parse(this.session.value.expiresAt) > Date.now() + 5_000) return this.session.value
    if (this.exchange?.key === key) return this.exchange.promise
    const promise = (async () => {
      const source = await this.options.acquireSource()
      this.assertContext(key)
      if (!source) throw new WorkspaceRequestError(401, 'UNAUTHENTICATED', 'Sign in or pair with this host.')
      const request: z.input<typeof solusApiOperations.exchangeCredential.body> = { scopes: this.options.scopes ?? ['tasks:read', 'tasks:write', 'works:read', 'works:write', 'sessions:read', 'insights:read'], shareSecret: this.options.shareSecret }
      const response = await (this.options.fetchImpl ?? fetch)(new URL('/v1/auth/session', this.options.baseUrl()), {
        method: 'POST', headers: { Authorization: 'Bearer ' + source, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) await this.fail(response)
      const value = workspaceAuthSessionSchema.parse(await response.json())
      this.assertContext(key); this.session = { key, value }; return value
    })()
    this.exchange = { key, promise }
    try { return await promise } finally { if (this.exchange?.promise === promise) this.exchange = null }
  }

  private async fail(response: Response): Promise<never> {
    const parsed = workspaceErrorSchema.safeParse(await response.json().catch(() => null))
    throw new WorkspaceRequestError(response.status, parsed.success ? parsed.data.error.code : 'REQUEST_FAILED', parsed.success ? parsed.data.error.message : 'The workspace request failed.')
  }

  async request<K extends SolusApiOperation>(operationId: K, input: RequestInput<K> & { ifNoneMatch: string }): Promise<ResponseFor<K> | undefined>
  async request<K extends SolusApiOperation>(operationId: K, input?: RequestInput<K>): Promise<ResponseFor<K>>
  async request<K extends SolusApiOperation>(operationId: K, input: RequestInput<K> & { ifNoneMatch?: string } = {}): Promise<ResponseFor<K> | undefined> {
    const operation = solusApiOperations[operationId]
    const key = this.key()
    const query = operation.query.parse(input.query ?? {})
    const path = operation.path.replace(/:[A-Za-z]+/, () => encodeURIComponent(input.id ?? ''))
    const url = new URL('/v1' + path, this.options.baseUrl())
    for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, String(value))
    const headers = new Headers()
    if (input.ifNoneMatch) headers.set('If-None-Match', JSON.stringify(input.ifNoneMatch))
    if (input.version !== undefined) headers.set('If-Match', JSON.stringify(input.version))
    if (input.key) headers.set('Idempotency-Key', input.key)
    const body = 'body' in operation ? JSON.stringify(operation.body.parse(input.body)) : undefined
    if (body) headers.set('Content-Type', 'application/json')
    for (let attempt = 0; attempt < 2; attempt++) {
      const credential = await this.credential(key)
      this.assertContext(key)
      headers.set('Authorization', 'Bearer ' + credential.accessToken)
      const response = await (this.options.fetchImpl ?? fetch)(url, { method: operation.method.toUpperCase(), headers, body, signal: AbortSignal.timeout(30_000) })
      this.assertContext(key)
      if (response.status === 401 && attempt === 0) { this.session = null; continue }
      if (response.status === 304 && input.ifNoneMatch) return undefined
      if (!response.ok) await this.fail(response)
      const value = 'response' in operation ? operation.response.parse(await response.json()) : undefined
      // SAFETY: The registry associates each operation key with this exact response schema.
      return value as ResponseFor<K>
    }
    throw new WorkspaceRequestError(401, 'UNAUTHENTICATED', 'The workspace credential was refused.')
  }
}
