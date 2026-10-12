import type { FetchLike } from '../admission/access-tokens'
import { DelegationError, type DelegationScope, type Delegations } from '../sync/delegations'

/**
 * Every read of a person's account goes here (docs/adr/0001-standard-authentication.md
 * §2.2 rule 7, §3.4): their account connections (GitHub, Google, Atlassian), their
 * agent profile, and their MCP credentials. The call carries the person's delegated
 * access token for the account plane as `Authorization: Bearer`, and nothing else: no
 * token in a body, no host token, no service key. A host and the Solus API read the
 * same way; each holds its own delegations.
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
  /** The delegations of this process; null before they exist. */
  delegations: () => Pick<Delegations, 'holders' | 'accessToken'> | null
  fetchImpl?: FetchLike
}

const REQUEST_TIMEOUT_MS = 15_000

export class AccountReads {
  constructor(private readonly deps: AccountReadsDeps) {}

  /**
   * One request to the account plane as the person. `scope` names the delegation to use;
   * null takes any the person has here, their personal one first: an account read is
   * the person's own data, and every delegation of theirs is checked alive at the call.
   */
  async fetch(userId: string, scope: DelegationScope | null, path: string, init: RequestInit = {}): Promise<Response | AccountReadRefusal> {
    const origin = this.deps.origin()
    const delegations = this.deps.delegations()
    if (!origin || !delegations) return { refused: 'NOT_LINKED', message: 'This host is not linked to Solus Cloud.' }
    const held = scope ?? scopeFor(delegations, userId)
    if (!held) return { refused: 'NO_DELEGATION', message: 'Reconnect to your host to authorize your account connections.' }
    let token: string
    try {
      token = await delegations.accessToken(userId, held, { kind: 'account' })
    } catch (error) {
      if (error instanceof DelegationError && error.code === 'ORGANIZATION_API_UNAVAILABLE') return { refused: 'UNREACHABLE', message: error.message }
      return { refused: 'NO_DELEGATION', message: error instanceof Error ? error.message : String(error) }
    }
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${token}`)
    try {
      return await (this.deps.fetchImpl ?? fetch)(new URL(path, origin).toString(), {
        ...init,
        headers,
        redirect: 'error',
        signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      return { refused: 'UNREACHABLE', message: `Solus Cloud is unreachable: ${error instanceof Error ? error.message : String(error)}` }
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
