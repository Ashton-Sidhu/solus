import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { formatCheckCode, normalizeCheckCode } from '@solus/contracts/add-machine'
import type { AppAccess } from '@solus/contracts/host-api'
import { isLoopbackHost, outsideAppOf, type OutsideAppId } from '@solus/contracts/outside-apps'
import { hostKindSchema, organizationRoleSchema } from '@solus/contracts/uplink'
import { isHostOwner, type Principal } from './principal'
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

/**
 * Who approved an app: the app acts as that person (plans/035 §0.3). The host's
 * owner approves in the Solus app or with a pairing code; an organization member
 * with a pairing code made in their own Solus client. A member's role and teams
 * are those at approval; the host checks on each call that they still have access.
 */
export const appApproverSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('owner') }).strict(),
  z.object({
    kind: z.literal('member'),
    userId: z.string().min(1),
    organizationId: z.string().min(1),
    organizationRole: organizationRoleSchema,
    teamIds: z.array(z.string()),
    hostKind: hostKindSchema,
    displayName: z.string(),
  }).strict(),
])
export type AppApprover = z.infer<typeof appApproverSchema>

/** The approver a principal is: the host owner, or an organization member; null for anyone else, who cannot connect an app. */
export function appApproverOf(principal: Principal): AppApprover | null {
  if (isHostOwner(principal)) return { kind: 'owner' }
  if (principal.kind !== 'org-member') return null
  return { kind: 'member', userId: principal.userId, organizationId: principal.organizationId, organizationRole: principal.organizationRole, teamIds: principal.teamIds, hostKind: principal.hostKind, displayName: principal.displayName }
}

/**
 * A pairing code lives ten minutes and works once, for the person who made it.
 * It names the access it gives, so the consent page does not ask again.
 */
export const APP_PAIRING_CODE_TTL_MS = 10 * 60 * 1000
interface AppPairingCode { expiresAt: number; approver: AppApprover; access: AppAccess }
const pairingCodes = new Map<string, AppPairingCode>()

export function createAppPairingCode(approver: AppApprover, access: AppAccess, now = Date.now()) {
  for (const [code, entry] of pairingCodes) if (entry.expiresAt <= now) pairingCodes.delete(code)
  const code = formatCheckCode((n) => randomInt(n))
  const expiresAt = now + APP_PAIRING_CODE_TTL_MS
  pairingCodes.set(code, { expiresAt, approver, access })
  return { code, access, expiresAt }
}

/** Spends a pairing code: who made it and the access it gives, or null when it is unknown, used, or expired. */
export function spendAppPairingCode(typed: string, now = Date.now()): Omit<AppPairingCode, 'expiresAt'> | null {
  const code = normalizeCheckCode(typed)
  if (!code) return null
  const entry = pairingCodes.get(code)
  pairingCodes.delete(code)
  return entry && entry.expiresAt > now ? { approver: entry.approver, access: entry.access } : null
}

/** The app a registered client is, from where its sign-in returns. */
export function appOfClient(client: RegisteredClient): OutsideAppId {
  return outsideAppOf(client.redirectUris)
}

/** Where the app's sign-in goes, as a person reads it: the host of a web address, else the app's scheme. */
export function redirectPlace(redirectUri: string) {
  const url = new URL(redirectUri)
  const web = url.protocol === 'http:' || url.protocol === 'https:'
  return { label: web ? url.host : `${url.protocol}${url.host ? `//${url.host}` : ''}`, onThisComputer: web && isLoopbackHost(url.hostname) }
}

/** What a sign-in asked for, kept with its authorization code. */
export interface AuthorizationRequest {
  clientId: string
  appName: string
  app: OutsideAppId
  redirectUri: string
  codeChallenge: string
  state: string | null
  access: AppAccess
}

/** An authorization code lives one minute (OAuth 2.1 §4.1.2). */
const CODE_TTL_MS = 60 * 1000
/** An approved sign-in, waiting for its code to be spent. */
export interface ApprovedSignIn extends AuthorizationRequest {
  approver: AppApprover
}
const codes = new Map<string, ApprovedSignIn & { expiresAt: number }>()

/** The address the app's browser goes back to, with a new authorization code for an approved sign-in. */
export function approvedRedirect(request: AuthorizationRequest, approver: AppApprover, now = Date.now()): string {
  for (const [code, entry] of codes) if (entry.expiresAt <= now) codes.delete(code)
  const code = randomBytes(32).toString('base64url')
  codes.set(code, { ...request, approver, expiresAt: now + CODE_TTL_MS })
  const url = new URL(request.redirectUri)
  url.searchParams.set('code', code)
  if (request.state !== null) url.searchParams.set('state', request.state)
  return url.toString()
}

/** The address the app's browser goes back to when the person denies the sign-in (RFC 6749 §4.1.2.1). */
export function deniedRedirect(request: Pick<AuthorizationRequest, 'redirectUri' | 'state'>): string {
  const url = new URL(request.redirectUri)
  url.searchParams.set('error', 'access_denied')
  if (request.state !== null) url.searchParams.set('state', request.state)
  return url.toString()
}

/** Ends the code in a redirect nobody followed. */
export function withdrawRedirect(redirect: string): void {
  const code = new URL(redirect).searchParams.get('code')
  if (code) codes.delete(code)
}

/** The sign-in a code was issued for, once: the client, its redirect address, and its PKCE verifier must match. */
export function redeemCode(code: string, clientId: string, redirectUri: string, codeVerifier: string, now = Date.now()): ApprovedSignIn | null {
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

/** What boot gives the app sign-in: the host's policies and its delegations (plans/035 §10). */
export interface AppAccessChecks {
  /** Why policy refuses this app for this approver's work, or null when it allows it. */
  appDenial(app: OutsideAppId, approver: AppApprover): string | null
  /** Whether a member who approved an app still has access to this host. */
  memberHasAccess(approver: Extract<AppApprover, { kind: 'member' }>): Promise<boolean>
}

/** Until boot installs the checks, every app is allowed and no member's grant works. */
let checks: AppAccessChecks = { appDenial: () => null, memberHasAccess: async () => false }

export function installAppAccessChecks(next: AppAccessChecks): void {
  checks = next
}

export function appAccessChecks(): AppAccessChecks {
  return checks
}
