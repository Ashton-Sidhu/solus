const API_BASE_URL = 'https://api.cloudflare.com/client/v4'

export interface CloudflareAccount {
  id: string
  name: string
}

export type CloudflareTokenVerification =
  | { kind: 'ok'; accounts: CloudflareAccount[]; expiresOn?: number }
  | { kind: 'invalid' }
  | { kind: 'network' }
  | { kind: 'accounts-forbidden' }

interface TokenVerifyResponse {
  success: boolean
  result?: { id?: string; status?: string; expires_on?: string | null }
}

interface AccountsResponse {
  success: boolean
  result?: Array<{ id?: string; name?: string }>
}

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

  let verification: TokenVerifyResponse
  try {
    verification = await verificationResponse.json() as TokenVerifyResponse
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

  let accountsPayload: AccountsResponse
  try {
    accountsPayload = await accountsResponse.json() as AccountsResponse
  } catch {
    return { kind: 'accounts-forbidden' }
  }
  if (!accountsResponse.ok || accountsPayload.success !== true || !Array.isArray(accountsPayload.result)) {
    return { kind: 'accounts-forbidden' }
  }

  const accounts = accountsPayload.result.flatMap((account): CloudflareAccount[] =>
    typeof account.id === 'string' && typeof account.name === 'string' ? [{ id: account.id, name: account.name }] : [],
  )
  return { kind: 'ok', accounts, expiresOn: expiresOn(verification.result.expires_on) }
}
