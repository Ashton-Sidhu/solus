import {
  ACCOUNT_SETTINGS_PATH,
  accountSettingsConflictBodySchema,
  accountSettingsResponseSchema,
  type AccountSettingsPatchRequest,
  type AccountSettingsResponse,
} from '@solus/contracts/settings'
import {
  hostPoliciesPath,
  hostPoliciesResponseSchema,
  hostPolicyAssignmentPath,
  hostPolicyPath,
  hostPolicySummarySchema,
  organizationPolicyPath,
  organizationPolicyResponseSchema,
  policyConflictBodySchema,
  policyHostSchema,
  policyRejectedBodySchema,
  type HostPolicyAssignRequest,
  type HostPolicyCreateRequest,
  type PolicyWriteRequest,
} from '@solus/contracts/policy-api'
import type { AccountSettingsResult, NativeSolusAPI, PolicyApiResult, SettingsRequestFailure } from '@solus/contracts/host-api'
import { uplinkErrorBodySchema } from '@solus/contracts/uplink'
import { z } from 'zod'
import type { WebTokenSession } from './web-token-session'
import { httpClient, sentOf } from './http-request'

export type { AccountSettingsResult, PolicyApiResult, SettingsRequestFailure }

/**
 * The account-plane settings calls (plans/018 §4), one typed method each. Every
 * client owns its credential differently — the web client its page's sign-in,
 * desktop main a bearer token it never gives the renderer, the native app a bearer
 * token in the keychain — so each has an adapter. All of them decode with the
 * contract schemas here, so a status means the same thing on every client.
 */

/** The policy API calls (plans/030 §5.2), on behalf of the signed-in account. */
export const POLICY_REQUEST_METHODS = [
  'organizationPolicyGet',
  'organizationPolicyPut',
  'hostPoliciesGet',
  'hostPolicyCreate',
  'hostPolicyPut',
  'hostPolicyDelete',
  'hostPolicyAssign',
  'hostPolicyUnassign',
] as const satisfies readonly (keyof NativeSolusAPI)[]
export type PolicyCloudRequests = Pick<NativeSolusAPI, (typeof POLICY_REQUEST_METHODS)[number]>

/**
 * The account settings calls and the policy calls. The desktop preload bridge
 * (`localApi` on desktop) has exactly these methods; `accountSettingsDelete`
 * clears the synced document and advances its generation.
 */
export type SettingsCloudRequests = Pick<NativeSolusAPI,
  | 'accountSettingsGet'
  | 'accountSettingsPatch'
  | 'accountSettingsDelete'> & PolicyCloudRequests

/** One request as an adapter sends it. The path is always one of the settings or policy paths. */
export interface SettingsHttpRequest {
  method: 'GET' | 'PATCH' | 'PUT' | 'POST' | 'DELETE'
  path: string
  body?: AccountSettingsPatchRequest | PolicyWriteRequest | HostPolicyCreateRequest | HostPolicyAssignRequest
}

/**
 * Builds the calls over one authenticated `send`. `send` returns null when the
 * website did not answer and 'signed-out' when there is no session to send with.
 */
export function settingsCloudRequests(
  send: (request: SettingsHttpRequest) => Promise<Response | null | 'signed-out'>,
  takeStartupSettings?: () => Promise<AccountSettingsResponse | null>,
): SettingsCloudRequests {
  const account = async (request: SettingsHttpRequest): Promise<AccountSettingsResult> => {
    const response = await send(request)
    if (response === 'signed-out') return { kind: 'signed-out' }
    if (!response) return { kind: 'offline' }
    const result = await accountSettingsResult(response)
    // A clear may answer without a body; the document it left is one read away.
    if (request.method === 'DELETE' && result.kind === 'error' && result.code === 'invalid_response' && response.ok) {
      return account({ method: 'GET', path: ACCOUNT_SETTINGS_PATH })
    }
    return result
  }
  const policy = async <Value>(request: SettingsHttpRequest, schema: z.ZodType<Value>): Promise<PolicyApiResult<Value>> => {
    const response = await send(request)
    if (response === 'signed-out') return { kind: 'signed-out' }
    if (!response) return { kind: 'offline' }
    return policyApiResult(response, schema)
  }
  return {
    accountSettingsGet: async () => {
      try {
        const startup = await takeStartupSettings?.()
        if (startup) return { kind: 'ok', settings: startup }
      } catch {
        return { kind: 'error', code: 'invalid_response', message: null }
      }
      return account({ method: 'GET', path: ACCOUNT_SETTINGS_PATH })
    },
    accountSettingsPatch: async (body) => {
      await takeStartupSettings?.().catch(() => null)
      return account({ method: 'PATCH', path: ACCOUNT_SETTINGS_PATH, body })
    },
    accountSettingsDelete: async () => {
      await takeStartupSettings?.().catch(() => null)
      return account({ method: 'DELETE', path: ACCOUNT_SETTINGS_PATH })
    },
    organizationPolicyGet: (organizationId) => policy({ method: 'GET', path: organizationPolicyPath(organizationId) }, organizationPolicyResponseSchema),
    organizationPolicyPut: (organizationId, body) => policy({ method: 'PUT', path: organizationPolicyPath(organizationId), body }, organizationPolicyResponseSchema),
    hostPoliciesGet: (organizationId) => policy({ method: 'GET', path: hostPoliciesPath(organizationId) }, hostPoliciesResponseSchema),
    hostPolicyCreate: (organizationId, body) => policy({ method: 'POST', path: hostPoliciesPath(organizationId), body }, hostPolicySummarySchema),
    hostPolicyPut: (organizationId, policyId, body) => policy({ method: 'PUT', path: hostPolicyPath(organizationId, policyId), body }, hostPolicySummarySchema),
    hostPolicyDelete: (organizationId, policyId) => policy({ method: 'DELETE', path: hostPolicyPath(organizationId, policyId) }, noBodySchema),
    hostPolicyAssign: (organizationId, hostId, body) => policy({ method: 'PUT', path: hostPolicyAssignmentPath(organizationId, hostId), body }, policyHostSchema),
    hostPolicyUnassign: (organizationId, hostId) => policy({ method: 'DELETE', path: hostPolicyAssignmentPath(organizationId, hostId) }, policyHostSchema),
  }
}

export async function accountSettingsResult(response: Response): Promise<AccountSettingsResult> {
  const body: unknown = await response.json().catch(() => null)
  if (response.status === 401) return { kind: 'signed-out' }
  if (response.status === 409) {
    const conflict = accountSettingsConflictBodySchema.safeParse(body)
    return conflict.success
      ? { kind: 'conflict', reason: conflict.data.error, current: conflict.data.current }
      : refusal(response.status, uplinkErrorBodySchema.safeParse(body))
  }
  if (!response.ok) return refusal(response.status, uplinkErrorBodySchema.safeParse(body))
  const parsed = accountSettingsResponseSchema.safeParse(body)
  return parsed.success ? { kind: 'ok', settings: parsed.data } : { kind: 'error', code: 'invalid_response', message: null }
}

/** A delete answers 204 or a body it does not need. */
const noBodySchema = z.unknown().transform(() => null)

/**
 * One policy API answer, the same on every client: 409 is a conflict with what
 * the other owner saved, 422 a refusal with its issues, 403 and 404 forbidden.
 */
export async function policyApiResult<Value>(response: Response, schema: z.ZodType<Value>): Promise<PolicyApiResult<Value>> {
  const body: unknown = response.status === 204 ? null : await response.json().catch(() => null)
  if (response.status === 401) return { kind: 'signed-out' }
  if (response.status === 403 || response.status === 404) return { kind: 'forbidden' }
  if (response.status === 409) {
    const conflict = policyConflictBodySchema.safeParse(body)
    return conflict.success
      ? { kind: 'conflict', revision: conflict.data.revision, document: conflict.data.document }
      : refusal(response.status, uplinkErrorBodySchema.safeParse(body))
  }
  if (response.status === 422) {
    const rejected = policyRejectedBodySchema.safeParse(body)
    return rejected.success
      ? { kind: 'rejected', reason: rejected.data.error, issues: rejected.data.issues }
      : refusal(response.status, uplinkErrorBodySchema.safeParse(body))
  }
  if (!response.ok) return refusal(response.status, uplinkErrorBodySchema.safeParse(body))
  const parsed = schema.safeParse(body)
  return parsed.success ? { kind: 'ok', value: parsed.data } : { kind: 'error', code: 'invalid_response', message: null }
}

function refusal(status: number, parsed: z.ZodSafeParseResult<z.infer<typeof uplinkErrorBodySchema>>): SettingsRequestFailure {
  return parsed.success
    ? { kind: 'error', code: parsed.data.error, message: parsed.data.message ?? null }
    : { kind: 'error', code: `http_${status}`, message: null }
}

/**
 * The web client served at the account origin: the page's sign-in gives an
 * account-plane access token for each call (docs/adr/0001-standard-authentication.md
 * §2.2); the website's cookie is not sent. The first read takes the settings the page's
 * HTML carried (`takeShellSettings`), with no request.
 */
export function webSettingsRequests(
  origin: string,
  session: Pick<WebTokenSession, 'accessToken'>,
  fetchImpl: typeof fetch = fetch,
  takeShellSettings?: () => Promise<AccountSettingsResponse | null>,
): SettingsCloudRequests {
  const cloud = httpClient({ baseUrl: origin, token: (options) => session.accessToken({ kind: 'account' }, options), fetch: fetchImpl })
  return settingsCloudRequests(async (request) => sentOf(await cloud.request(request.path, { method: request.method, body: request.body })), takeShellSettings)
}
