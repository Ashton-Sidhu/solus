const API_BASE_URL = 'https://api.cloudflare.com/client/v4'
import { z } from 'zod'

export interface CloudflareAccount {
  id: string
  name: string
}

export type CloudflareTokenVerification =
  | { kind: 'ok'; accounts: CloudflareAccount[]; expiresOn?: number }
  | { kind: 'invalid' }
  | { kind: 'network' }
  | { kind: 'accounts-forbidden' }

const tokenVerifyResponseSchema = z.object({
  success: z.boolean(),
  result: z.object({
    id: z.string().optional(),
    status: z.string().optional(),
    expires_on: z.string().nullable().optional(),
  }).optional(),
})

const accountsResponseSchema = z.object({
  success: z.boolean(),
  result: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
})

function isForbidden(response: Response): boolean {
  return response.status === 401 || response.status === 403
}

function expiresOn(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? undefined : timestamp
}

export async function verifyCloudflareToken(apiToken: string): Promise<CloudflareTokenVerification> {
  const headers = { authorization: `Bearer ${apiToken}` }
  let verificationResponse: Response
  try {
    verificationResponse = await fetch(`${API_BASE_URL}/user/tokens/verify`, { headers })
  } catch {
    return { kind: 'network' }
  }

  if (isForbidden(verificationResponse)) return { kind: 'invalid' }

  let verification: z.infer<typeof tokenVerifyResponseSchema>
  try {
    verification = tokenVerifyResponseSchema.parse(await verificationResponse.json())
  } catch {
    return { kind: 'invalid' }
  }
  if (!verificationResponse.ok || verification.success !== true || verification.result?.status !== 'active') {
    return { kind: 'invalid' }
  }

  let accountsResponse: Response
  try {
    accountsResponse = await fetch(`${API_BASE_URL}/accounts`, { headers })
  } catch {
    return { kind: 'network' }
  }
  if (isForbidden(accountsResponse)) return { kind: 'accounts-forbidden' }

  let accountsPayload: z.infer<typeof accountsResponseSchema>
  try {
    accountsPayload = accountsResponseSchema.parse(await accountsResponse.json())
  } catch {
    return { kind: 'accounts-forbidden' }
  }
  if (!accountsResponse.ok || accountsPayload.success !== true || !Array.isArray(accountsPayload.result)) {
    return { kind: 'accounts-forbidden' }
  }

  const accounts: CloudflareAccount[] = accountsPayload.result
  return { kind: 'ok', accounts, expiresOn: expiresOn(verification.result.expires_on) }
}
