import {
  ACCOUNT_DOCUMENTS,
  type AccountDocumentName,
  type AccountDocumentRequest,
  type AccountDocumentResponse,
  type AccountDocumentResult,
} from '@solus/contracts/account-documents'
import { uplinkErrorBodySchema } from '@solus/contracts/uplink'
import type { WebTokenSession } from './web-token-session'

/**
 * The account documents (`contracts/account-documents.ts`) as one call: a client
 * gives how it sends a request with its own sign-in, and every document decodes
 * the same way from its row of the table.
 */

/** A request as it goes over HTTP: the route and method from the table, and the body. */
export interface AccountDocumentHttp {
  method: 'GET' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
}

/** Answers null when the website did not answer, and 'signed-out' with no sign-in to send with. */
export type AccountDocumentSend = (request: AccountDocumentHttp) => Promise<Response | null | 'signed-out'>

export type AccountDocumentCall = <N extends AccountDocumentName>(request: AccountDocumentRequest<N>) => Promise<AccountDocumentResult<N>>

export function accountDocumentCall(send: AccountDocumentSend): AccountDocumentCall {
  return async <N extends AccountDocumentName>(request: AccountDocumentRequest<N>): Promise<AccountDocumentResult<N>> => {
    const spec = ACCOUNT_DOCUMENTS[request.name]
    const response = await send({ method: request.method, path: spec.path, body: request.method === 'PATCH' ? request.body : undefined })
    if (response === 'signed-out') return { kind: 'signed-out' }
    if (!response) return { kind: 'offline' }
    const body: unknown = await response.json().catch(() => null)
    if (response.status === 401) return { kind: 'signed-out' }
    if (response.status === 409) {
      const conflict = spec.conflict.safeParse(body)
      // SAFETY: the conflict schema of row N carries row N's response as `current`.
      return conflict.success ? { kind: 'conflict', reason: conflict.data.error, current: conflict.data.current as AccountDocumentResponse<N> } : { kind: 'error', code: 'invalid_response', message: null }
    }
    if (!response.ok) {
      const refused = uplinkErrorBodySchema.safeParse(body)
      return { kind: 'error', code: refused.success ? refused.data.error : `http_${response.status}`, message: refused.success ? refused.data.message ?? null : null }
    }
    const document = spec.response.safeParse(body)
    // SAFETY: row N's response schema decodes row N's document.
    return document.success ? { kind: 'ok', document: document.data as AccountDocumentResponse<N> } : { kind: 'error', code: 'invalid_response', message: null }
  }
}

/** The web client's send: an account-plane token from the page's sign-in, at the account origin. */
export function webAccountDocumentSend(origin: string, session: Pick<WebTokenSession, 'accessToken'>, fetchImpl: typeof fetch = fetch): AccountDocumentSend {
  return async (request) => {
    const token = await session.accessToken({ kind: 'account' })
    if (!token) return 'signed-out'
    const headers = new Headers({ accept: 'application/json', authorization: `Bearer ${token}` })
    if (request.body !== undefined) headers.set('content-type', 'application/json')
    try {
      return await fetchImpl(`${origin}${request.path}`, {
        method: request.method,
        credentials: 'omit',
        headers,
        body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      return null
    }
  }
}
