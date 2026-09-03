import { z } from 'zod'
import type { DeviceSignInEnd } from '@solus/contracts/account-types'

/** RFC 8628 device authorization shared by desktop and the server CLI. */

export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

const deviceCodeResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.url(),
  verification_uri_complete: z.url(),
  expires_in: z.number().positive(),
  interval: z.number().positive(),
})

const tokenSuccessSchema = z.object({ access_token: z.string().min(1) })
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
  | { end: 'approved'; sessionToken: string }
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
    body: JSON.stringify({ client_id: deps.clientId }),
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
      response = await deps.fetch(`${deps.cloudOrigin}/api/auth/device/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          grant_type: DEVICE_GRANT_TYPE,
          device_code: grant.deviceCode,
          client_id: grant.clientId,
        }),
        signal,
      })
    } catch {
      if (signal.aborted) return { end: 'cancelled', message: 'Sign-in cancelled.' }
      continue
    }

    const body: unknown = await response.json().catch(() => null)
    if (response.ok) {
      const success = tokenSuccessSchema.safeParse(body)
      if (success.success) return { end: 'approved', sessionToken: success.data.access_token }
      return { end: 'error', message: 'The website answered without a session.' }
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
