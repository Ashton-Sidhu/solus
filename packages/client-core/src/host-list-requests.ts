import {
  HOST_LIST_PATH,
  accountHostListConflictBodySchema,
  accountHostListResponseSchema,
  type AccountHostListPatchRequest,
} from '@solus/contracts/host-list'
import type { AccountHostListResult, NativeSolusAPI, SettingsRequestFailure } from '@solus/contracts/host-api'
import { uplinkErrorBodySchema } from '@solus/contracts/uplink'
import type { WebTokenSession } from './web-token-session'

/**
 * The account host list calls (plans/031 D7), one typed method each over one
 * authenticated `send`, as the agent profile calls are (`agent-profile-requests.ts`).
 * Each client owns its credential differently, so each has an adapter; all decode
 * with the contract schemas here.
 */

export type HostListCloudRequests = Pick<NativeSolusAPI, 'accountHostListGet' | 'accountHostListPatch' | 'accountHostListDelete'>

export interface HostListHttpRequest {
  method: 'GET' | 'PATCH' | 'DELETE'
  path: string
  body?: AccountHostListPatchRequest
}

type Sent = Response | null | 'signed-out'

/** `send` returns null when the website did not answer and 'signed-out' when there is no session to send with. */
export function hostListCloudRequests(send: (request: HostListHttpRequest) => Promise<Sent>): HostListCloudRequests {
  const document = async (request: HostListHttpRequest): Promise<AccountHostListResult> => {
    const response = await send(request)
    if (response === 'signed-out') return { kind: 'signed-out' }
    if (!response) return { kind: 'offline' }
    return accountHostListResult(response)
  }
  return {
    accountHostListGet: () => document({ method: 'GET', path: HOST_LIST_PATH }),
    accountHostListPatch: (body) => document({ method: 'PATCH', path: HOST_LIST_PATH, body }),
    accountHostListDelete: () => document({ method: 'DELETE', path: HOST_LIST_PATH }),
  }
}

function failure(response: Response, parsed: ReturnType<typeof uplinkErrorBodySchema.safeParse>): SettingsRequestFailure {
  return { kind: 'error', code: parsed.success ? parsed.data.error : `http_${response.status}`, message: parsed.success ? parsed.data.message ?? null : null }
}

export async function accountHostListResult(response: Response): Promise<AccountHostListResult> {
  const body: unknown = await response.json().catch(() => null)
  if (response.status === 401) return { kind: 'signed-out' }
  if (response.status === 409) {
    const conflict = accountHostListConflictBodySchema.safeParse(body)
    return conflict.success
      ? { kind: 'conflict', reason: conflict.data.error, current: conflict.data.current }
      : { kind: 'error', code: 'invalid_response', message: null }
  }
  if (!response.ok) return failure(response, uplinkErrorBodySchema.safeParse(body))
  const hosts = accountHostListResponseSchema.safeParse(body)
  return hosts.success ? { kind: 'ok', hosts: hosts.data } : { kind: 'error', code: 'invalid_response', message: null }
}

/** The web client's adapter: an account-plane access token from the page's sign-in, at the account origin. */
export function webHostListRequests(origin: string, session: Pick<WebTokenSession, 'accessToken'>, fetchImpl: typeof fetch = fetch): HostListCloudRequests {
  return hostListCloudRequests(async (request) => {
    const token = await session.accessToken({ kind: 'account' })
    if (!token) return 'signed-out'
    const headers = new Headers({ accept: 'application/json', authorization: `Bearer ${token}` })
    if (request.body) headers.set('content-type', 'application/json')
    try {
      return await fetchImpl(`${origin}${request.path}`, {
        method: request.method,
        credentials: 'omit',
        headers,
        body: request.body ? JSON.stringify(request.body) : undefined,
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      return null
    }
  })
}
