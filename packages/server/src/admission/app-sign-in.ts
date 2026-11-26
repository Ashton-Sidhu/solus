import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { formatCheckCode, normalizeCheckCode } from '@solus/contracts/add-machine'
import type { AppAccess } from '@solus/contracts/host-api'
import { getAssetSigningSecret, readSignedToken, signToken } from './signed-token'

/**
 * An outside app's OAuth sign-in to this host (plans/035 §10): the host is its
 * own authorization server. A client registers without a record (its id is a
 * signed copy of what it sent), the owner approves in the Solus app or with a
 * pairing code, and an authorization code is spent once, with PKCE, for the
 * app's grant. Codes live in memory: a restart ends a sign-in in progress.
 */

/** A client's id: its name and redirect addresses, signed by this host. No other token has this shape. */
const clientIdSchema = z.object({
  mcpClient: z.literal(1),
  name: z.string().min(1).max(64),
  redirectUris: z.array(z.url()).min(1).max(8),
}).strict()
export type RegisteredClient = z.infer<typeof clientIdSchema>

export function registerClient(name: string, redirectUris: string[]): string {
  const client: RegisteredClient = { mcpClient: 1, name: name.trim().slice(0, 64) || 'MCP app', redirectUris }
  return signToken(client, getAssetSigningSecret())
}

export function registeredClient(clientId: string): RegisteredClient | null {
  return readSignedToken(clientId, getAssetSigningSecret(), clientIdSchema)
}

/** A pairing code lives ten minutes and works once. */
export const APP_PAIRING_CODE_TTL_MS = 10 * 60 * 1000
const pairingCodes = new Map<string, number>()

export function createAppPairingCode(now = Date.now()) {
  for (const [code, expiresAt] of pairingCodes) if (expiresAt <= now) pairingCodes.delete(code)
  const code = formatCheckCode((n) => randomInt(n))
  const expiresAt = now + APP_PAIRING_CODE_TTL_MS
  pairingCodes.set(code, expiresAt)
  return { code, expiresAt }
}

/** Spends a pairing code. False when it is unknown, used, or expired. */
export function spendAppPairingCode(typed: string, now = Date.now()): boolean {
  const code = normalizeCheckCode(typed)
  if (!code) return false
  const expiresAt = pairingCodes.get(code)
  pairingCodes.delete(code)
  return expiresAt !== undefined && expiresAt > now
}

/** What a sign-in asked for, kept with its authorization code. */
export interface AuthorizationRequest {
  clientId: string
  appName: string
  redirectUri: string
  codeChallenge: string
  state: string | null
  access: AppAccess
}

/** An authorization code lives one minute (OAuth 2.1 §4.1.2). */
const CODE_TTL_MS = 60 * 1000
const codes = new Map<string, AuthorizationRequest & { expiresAt: number }>()

/** The address the app's browser goes back to, with a new authorization code. */
export function approvedRedirect(request: AuthorizationRequest, now = Date.now()): string {
  for (const [code, entry] of codes) if (entry.expiresAt <= now) codes.delete(code)
  const code = randomBytes(32).toString('base64url')
  codes.set(code, { ...request, expiresAt: now + CODE_TTL_MS })
  const url = new URL(request.redirectUri)
  url.searchParams.set('code', code)
  if (request.state !== null) url.searchParams.set('state', request.state)
  return url.toString()
}

/** Ends the code in a redirect nobody followed. */
export function withdrawRedirect(redirect: string): void {
  const code = new URL(redirect).searchParams.get('code')
  if (code) codes.delete(code)
}

/** The sign-in a code was issued for, once: the client, its redirect address, and its PKCE verifier must match. */
export function redeemCode(code: string, clientId: string, redirectUri: string, codeVerifier: string, now = Date.now()): AuthorizationRequest | null {
  const entry = codes.get(code)
  codes.delete(code)
  if (!entry || entry.expiresAt <= now || entry.clientId !== clientId || entry.redirectUri !== redirectUri) return null
  const challenge = createHash('sha256').update(codeVerifier).digest('base64url')
  const expected = Buffer.from(entry.codeChallenge)
  const received = Buffer.from(challenge)
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null
  return entry
}

/** Clears codes for a test. */
export function resetAppSignInForTests(): void {
  pairingCodes.clear()
  codes.clear()
}
