import { z } from 'zod'
import type { FetchLike } from '../admission/access-tokens'
import { DelegationError, type DelegationScope, type Delegations } from '../sync/delegations'
import { fetchAccountPlane } from '../host/account-plane'

/**
 * Every read of a person's account goes here (docs/adr/0001-standard-authentication.md
 * §2.2 rule 7, §3.4): their account connections (GitHub, Google, Atlassian), their
 * agent profile, and their MCP credentials. The call carries one token as
 * `Authorization: Bearer`, and nothing else: no token in a body, no host token, no
 * service key. That token is the person's own token for our servers where this
 * process holds one (the Solus API: the token their client presented, whose `aud`
 * includes the account plane; docs/plans/simplify-auth-and-sync.md §3 rule 1), and
 * this host's delegation for them otherwise.
 */

export type AccountReadRefusalCode =
  /** This host is not linked, or the Solus API has no account plane: there is nobody to ask. */
  | 'NOT_LINKED'
  /** This host does not act for the person, or the account plane ended the delegation. */
  | 'NO_DELEGATION'
  /** The account plane did not answer. */
  | 'UNREACHABLE'

/** Why no request was sent, with words a person can act on. */
export interface AccountReadRefusal {
  readonly refused: AccountReadRefusalCode
  readonly message: string
}

export interface AccountReadsDeps {
  /** The account plane's origin: the link's directory, or the Solus API's issuer; null when there is none. */
  origin: () => string | null
  /** The delegations of this process; null before they exist, and always in the Solus API. */
  delegations: () => Pick<Delegations, 'holders' | 'accessToken'> | null
  /** The person's own live token for our servers, when this process holds one (`PresentedTokens`). */
  ownToken?: (userId: string) => string | null
  fetchImpl?: FetchLike
}

const REQUEST_TIMEOUT_MS = 15_000
const NOT_LINKED: AccountReadRefusal = { refused: 'NOT_LINKED', message: 'This host is not linked to Solus Cloud.' }
/** A token this close to its end is not used: the account plane could see it expired. */
const OWN_TOKEN_MARGIN_MS = 60_000

const ownTokenClaimsSchema = z.object({ sub: z.string().min(1), exp: z.number() })

/**
 * The newest token each person presented to this process for our servers, kept until
 * a minute before it ends (the Solus API: the token a client dials with, or renews or
 * presents on its socket). Its `aud` includes the account plane, so the Solus API
 * reads the person's account with it directly; the account plane checks its grant at
 * each call, so a sign-out ends it there at once. The token is never logged or stored.
 */
export class PresentedTokens {
  private readonly byUser = new Map<string, { token: string; expiresAt: number }>()

  constructor(private readonly now: () => number = Date.now) {}

  /** The verifier admitted this token already; only its subject and end are read here. */
  keep(token: string): void {
    const claims = ownTokenClaimsOf(token)
    if (!claims) return
    const expiresAt = claims.exp * 1000
    const held = this.byUser.get(claims.sub)
    if (!held || held.expiresAt < expiresAt) this.byUser.set(claims.sub, { token, expiresAt })
  }

  tokenFor(userId: string): string | null {
    const held = this.byUser.get(userId)
    if (!held) return null
    if (held.expiresAt - OWN_TOKEN_MARGIN_MS > this.now()) return held.token
    this.byUser.delete(userId)
    return null
  }
}

/** The subject and end of a token the verifier admitted; null for anything else. */
function ownTokenClaimsOf(token: string): z.infer<typeof ownTokenClaimsSchema> | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const parsed = ownTokenClaimsSchema.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export class AccountReads {
  constructor(private readonly deps: AccountReadsDeps) {}

  /**
   * One request to the account plane as the person. `scope` names the delegation to use;
   * null takes any the person has here, their personal one first: an account read is
   * the person's own data, and every delegation of theirs is checked alive at the call.
   */
  async fetch(userId: string, scope: DelegationScope | null, path: string, init: RequestInit = {}): Promise<Response | AccountReadRefusal> {
    const origin = this.deps.origin()
    if (!origin) return NOT_LINKED
    const own = this.deps.ownToken?.(userId)
    const bearer = own ? { token: own } : await this.delegatedToken(userId, scope)
    if ('refused' in bearer) return bearer
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${bearer.token}`)
    try {
      return await fetchAccountPlane(this.deps.fetchImpl, new URL(path, origin).toString(), {
        ...init,
        headers,
        redirect: 'error',
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      return { refused: 'UNREACHABLE', message: `Solus Cloud is unreachable: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** This host's delegated token for the person, for the account plane; a refusal when it holds none. */
  private async delegatedToken(userId: string, scope: DelegationScope | null): Promise<{ token: string } | AccountReadRefusal> {
    const delegations = this.deps.delegations()
    if (!delegations) return NOT_LINKED
    const held = scope ?? scopeFor(delegations, userId)
    if (!held) return { refused: 'NO_DELEGATION', message: 'Reconnect to your host to authorize your account connections.' }
    try {
      return { token: await delegations.accessToken(userId, held, { kind: 'account' }) }
    } catch (error) {
      if (error instanceof DelegationError && error.code === 'ORGANIZATION_API_UNAVAILABLE') return { refused: 'UNREACHABLE', message: error.message }
      return { refused: 'NO_DELEGATION', message: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Where a person manages their account connections, on the account plane this process reads. */
  connectionsUrl(): string | null {
    const origin = this.deps.origin()
    return origin ? new URL('/connections', origin).toString() : null
  }
}

/** The delegation an unscoped read uses: the person's personal one, else one of an organization. */
function scopeFor(delegations: Pick<Delegations, 'holders'>, userId: string): DelegationScope | null {
  const held = delegations.holders().filter((holder) => holder.userId === userId)
  return held.find((holder) => holder.scope === 'personal')?.scope ?? held[0]?.scope ?? null
}

// ── The process's reads, for code that holds a person and no server object ──

let installed: AccountReads | null = null

/** Installed by the server at boot; the provider credential reads and the connection pointers use it. */
export function useAccountReads(reads: AccountReads | null): void {
  installed = reads
}

const NONE = new AccountReads({ origin: () => null, delegations: () => null })

/** The reads this process installed; one that refuses everything before the server installs them. */
export function accountReads(): AccountReads {
  return installed ?? NONE
}

export function accountConnectionsUrl(): string | null {
  return accountReads().connectionsUrl()
}
