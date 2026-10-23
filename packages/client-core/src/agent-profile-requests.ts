import {
  AGENT_PROFILE_PATH,
  accountAgentProfileConflictBodySchema,
  accountAgentProfileResponseSchema,
  type AccountAgentProfilePatchRequest,
} from '@solus/contracts/agent-profile'
import {
  VAULT_CONNECT_PATH,
  VAULT_PATH,
  vaultConnectResultSchema,
  vaultConnectionListSchema,
  type VaultSaveKeyRequest,
  type VaultConnectRequest,
  type VaultDisconnectRequest,
} from '@solus/contracts/vault'
import type { AccountAgentProfileResult, AccountVaultConnectResult, AccountVaultResult, NativeSolusAPI, SettingsRequestFailure } from '@solus/contracts/host-api'
import { SOLUS_PROTOCOL, SOLUS_PROTOCOL_HEADER, uplinkErrorBodySchema } from '@solus/contracts/uplink'
import type { OAuthSession } from './oauth-session'

/**
 * The account agent profile calls (plans/020-agent-profile.md §3), one typed
 * method each, built over one authenticated `send` as the settings calls are
 * (`settings-requests.ts`): the document, and the person's account vault
 * (docs/plans/cloud-vault.md §2.3): every connection's status, a sign-in, a
 * pasted key, a disconnect. Every client owns its credential differently, so
 * each has an adapter; all decode with the contract schemas here.
 */

export type AgentProfileCloudRequests = Pick<NativeSolusAPI,
  | 'accountAgentProfileGet'
  | 'accountAgentProfilePatch'
  | 'accountAgentProfileDelete'
  | 'accountVault'
  | 'accountVaultConnect'
  | 'accountVaultSaveKey'
  | 'accountVaultDisconnect'>

export interface AgentProfileHttpRequest {
  method: 'GET' | 'PATCH' | 'PUT' | 'POST' | 'DELETE'
  path: string
  body?: AccountAgentProfilePatchRequest | VaultConnectRequest | VaultSaveKeyRequest | VaultDisconnectRequest
}

type Sent = Response | null | 'signed-out'

/** `send` returns null when the website did not answer and 'signed-out' when there is no session to send with. */
export function agentProfileCloudRequests(send: (request: AgentProfileHttpRequest) => Promise<Sent>): AgentProfileCloudRequests {
  const document = async (request: AgentProfileHttpRequest): Promise<AccountAgentProfileResult> => {
    const response = await send(request)
    if (response === 'signed-out') return { kind: 'signed-out' }
    if (!response) return { kind: 'offline' }
    const result = await accountAgentProfileResult(response)
    // A clear may answer without a body; the document it left is one read away.
    if (request.method === 'DELETE' && result.kind === 'error' && result.code === 'invalid_response' && response.ok) {
      return document({ method: 'GET', path: AGENT_PROFILE_PATH })
    }
    return result
  }
  const vault = async (): Promise<AccountVaultResult> => {
    const response = await send({ method: 'GET', path: VAULT_PATH })
    if (response === 'signed-out') return { kind: 'signed-out' }
    if (!response) return { kind: 'offline' }
    const body: unknown = await response.json().catch(() => null)
    if (response.status === 401) return { kind: 'signed-out' }
    if (!response.ok) return failure(response, uplinkErrorBodySchema.safeParse(body))
    const parsed = vaultConnectionListSchema.safeParse(body)
    return parsed.success ? { kind: 'ok', connections: parsed.data.connections } : { kind: 'error', code: 'invalid_response', message: null }
  }
  /** A write to the vault, then its statuses as they are after it. */
  const write = async (request: AgentProfileHttpRequest): Promise<AccountVaultResult> => {
    const response = await send(request)
    if (response === 'signed-out') return { kind: 'signed-out' }
    if (!response) return { kind: 'offline' }
    if (response.status === 401) return { kind: 'signed-out' }
    if (!response.ok) return failure(response, uplinkErrorBodySchema.safeParse(await response.json().catch(() => null)))
    return vault()
  }
  return {
    accountAgentProfileGet: () => document({ method: 'GET', path: AGENT_PROFILE_PATH }),
    accountAgentProfilePatch: (body) => document({ method: 'PATCH', path: AGENT_PROFILE_PATH, body }),
    accountAgentProfileDelete: () => document({ method: 'DELETE', path: AGENT_PROFILE_PATH }),
    accountVault: vault,
    accountVaultConnect: async (body): Promise<AccountVaultConnectResult> => {
      const response = await send({ method: 'POST', path: VAULT_CONNECT_PATH, body })
      if (response === 'signed-out') return { kind: 'signed-out' }
      if (!response) return { kind: 'offline' }
      const answer: unknown = await response.json().catch(() => null)
      if (response.status === 401) return { kind: 'signed-out' }
      if (response.status === 404 || response.status === 400 || response.status === 502) {
        const refused = uplinkErrorBodySchema.safeParse(answer)
        return { kind: 'refused', message: refused.success && refused.data.message ? refused.data.message : 'Solus Cloud cannot sign in to this server. It must be a public HTTPS address.' }
      }
      if (!response.ok) return failure(response, uplinkErrorBodySchema.safeParse(answer))
      const parsed = vaultConnectResultSchema.safeParse(answer)
      return parsed.success ? { kind: 'ok', start: parsed.data } : { kind: 'error', code: 'invalid_response', message: null }
    },
    accountVaultSaveKey: (body) => write({ method: 'PUT', path: VAULT_PATH, body }),
    accountVaultDisconnect: (body) => write({ method: 'DELETE', path: VAULT_PATH, body }),
  }
}

/** A refusal as the client reads it: the website's own error word when it gave one, else the status. */
function failure(response: Response, parsed: ReturnType<typeof uplinkErrorBodySchema.safeParse>): SettingsRequestFailure {
  return { kind: 'error', code: parsed.success ? parsed.data.error : `http_${response.status}`, message: parsed.success ? parsed.data.message ?? null : null }
}

export async function accountAgentProfileResult(response: Response): Promise<AccountAgentProfileResult> {
  const body: unknown = await response.json().catch(() => null)
  if (response.status === 401) return { kind: 'signed-out' }
  if (response.status === 409) {
    const conflict = accountAgentProfileConflictBodySchema.safeParse(body)
    return conflict.success
      ? { kind: 'conflict', reason: conflict.data.error, current: conflict.data.current }
      : { kind: 'error', code: 'invalid_response', message: null }
  }
  if (!response.ok) return failure(response, uplinkErrorBodySchema.safeParse(body))
  const profile = accountAgentProfileResponseSchema.safeParse(body)
  return profile.success ? { kind: 'ok', profile: profile.data } : { kind: 'error', code: 'invalid_response', message: null }
}

/** The web client's adapter: an account-plane access token from the page's sign-in, at the account origin. */
export function webAgentProfileRequests(origin: string, session: Pick<OAuthSession, 'accessToken'>, fetchImpl: typeof fetch = fetch): AgentProfileCloudRequests {
  return agentProfileCloudRequests(async (request) => {
    const token = await session.accessToken({ kind: 'account' })
    if (!token) return 'signed-out'
    const headers = new Headers({ accept: 'application/json', authorization: `Bearer ${token}`, [SOLUS_PROTOCOL_HEADER]: String(SOLUS_PROTOCOL) })
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
