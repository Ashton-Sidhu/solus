import { z } from 'zod'
import type { DeviceSignInEnd } from '@solus/contracts/account-types'
import { SIGN_IN_SCOPES } from '@solus/contracts/auth/clients'
import { oauthTokenResponseSchema, type OAuthTokenResponse } from './oauth-session'

/**
 * RFC 8628 device authorization for the server CLI
 * (docs/adr/0001-standard-authentication.md §2.2 rule 1). The device-authorization
 * plugin gives the code and the approval page; the account plane's token endpoint
 * answers the approved code with OAuth tokens and a new client grant, which the
 * caller adopts into an `OAuthSession`.
 */

export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

const deviceCodeResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.url(),
  verification_uri_complete: z.url(),
  expires_in: z.number().positive(),
  interval: z.number().positive(),
})

const tokenErrorSchema = z.object({
  error: z.enum(['authorization_pending', 'slow_down', 'expired_token', 'access_denied', 'invalid_grant']).or(z.string()),
})

export interface DeviceCodeGrant {
  deviceCode: string
  userCode: string
  verificationUrl: string
  expiresAt: number
  intervalSeconds: number
  clientId: string
}

export type DeviceSignInResult =
  | { end: 'approved'; tokens: OAuthTokenResponse }
  | { end: Exclude<DeviceSignInEnd, 'approved'>; message: string }

export interface DeviceAuthorizationDeps {
  cloudOrigin: string
  clientId: string
  fetch: typeof fetch
  now: () => number
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
}

export class DeviceAuthorizationError extends Error {}

export async function requestDeviceCode(
  deps: Pick<DeviceAuthorizationDeps, 'cloudOrigin' | 'clientId' | 'fetch' | 'now'>,
): Promise<DeviceCodeGrant> {
  const response = await deps.fetch(`${deps.cloudOrigin}/api/auth/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_id: deps.clientId, scope: SIGN_IN_SCOPES.join(' ') }),
  })
  if (!response.ok) throw new DeviceAuthorizationError(`device code request failed (${response.status})`)
  const parsed = deviceCodeResponseSchema.safeParse(await response.json())
  if (!parsed.success) throw new DeviceAuthorizationError('device code response was not understood')
  return {
    deviceCode: parsed.data.device_code,
    userCode: parsed.data.user_code,
    verificationUrl: parsed.data.verification_uri_complete,
    expiresAt: deps.now() + parsed.data.expires_in * 1000,
    intervalSeconds: parsed.data.interval,
    clientId: deps.clientId,
  }
}

export async function waitForDeviceApproval(
  grant: DeviceCodeGrant,
  deps: Omit<DeviceAuthorizationDeps, 'clientId'>,
  signal: AbortSignal,
): Promise<DeviceSignInResult> {
  let intervalMs = grant.intervalSeconds * 1000
  while (true) {
    if (signal.aborted) return { end: 'cancelled', message: 'Sign-in cancelled.' }
    if (deps.now() >= grant.expiresAt) return { end: 'expired', message: 'The code expired before it was approved.' }

    try {
      await deps.sleep(intervalMs, signal)
    } catch {
      return { end: 'cancelled', message: 'Sign-in cancelled.' }
    }
    if (signal.aborted) return { end: 'cancelled', message: 'Sign-in cancelled.' }

    let response: Response
    try {
      response = await deps.fetch(`${deps.cloudOrigin}/api/auth/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: DEVICE_GRANT_TYPE,
          device_code: grant.deviceCode,
          client_id: grant.clientId,
        }).toString(),
        signal,
      })
    } catch {
      if (signal.aborted) return { end: 'cancelled', message: 'Sign-in cancelled.' }
      continue
    }

    const body: unknown = await response.json().catch(() => null)
    if (response.ok) {
      const success = oauthTokenResponseSchema.safeParse(body)
      if (success.success && success.data.refresh_token && success.data.id_token) return { end: 'approved', tokens: success.data }
      return { end: 'error', message: 'The website answered without OAuth tokens.' }
    }

    const failure = tokenErrorSchema.safeParse(body)
    const code = failure.success ? failure.data.error : 'unknown'
    switch (code) {
      case 'authorization_pending':
        continue
      case 'slow_down':
        intervalMs += 5000
        continue
      case 'expired_token':
        return { end: 'expired', message: 'The code expired before it was approved.' }
      case 'access_denied':
        return { end: 'denied', message: 'The sign-in was denied in the browser.' }
      default:
        return { end: 'error', message: `The website refused the sign-in (${code}).` }
    }
  }
}

/** `BCDFGHJK` → `BCDF-GHJK`, the way the website shows it. Other lengths pass through. */
export function formatUserCode(code: string): string {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (normalized.length !== 8) return normalized
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`
}
