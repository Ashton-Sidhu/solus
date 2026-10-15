import { homedir } from 'node:os'
import { z } from 'zod'
import { parseGithubScopes } from '@solus/contracts/github-auth'
import type { AuthStatus, DeviceCodePrompt, GithubDelegatedCredential } from '@solus/contracts/types'
import type { ProviderRef } from '@solus/contracts/vault'
import { runAsync } from '../../git/exec'
import { createLogger } from '../../logger'
import { currentPersonKey } from '../../vault/acting-scope'
import { credentialLocationOf, isMachineOwner, usesAccountIntegration, vault, type Vault } from '../../vault/vault'
import type { ProviderAuth } from '../types'
import { authorizeWithDeviceFlow } from './auth'
import { GITHUB_CLIENT_ID } from './client-id'
import { clearDelegation, loadDelegation, saveDelegation } from './delegation-store'
import { clientFor, type GitHubClient } from './octokit'

/**
 * The one owner of the GitHub credential policy: which credential an operation
 * acts with, and the person's own GitHub login. `delegation-store` is this
 * module's implementation — read it from here, not directly, so the policy
 * cannot fork again.
 */

const log = createLogger('main', 'github-credentials')

export type GithubCredentialSource = 'account' | 'delegated' | 'host' | 'gh-cli'

export interface GithubCredential {
  source: GithubCredentialSource
  token: string
}

/**
 * Persisted GitHub OAuth App user token. No `expiresAt`/`refreshToken`: OAuth
 * App user tokens are non-expiring by default. If we later enable expiring
 * tokens, add those fields plus a refresh path (mirroring google/oauth.ts).
 *
 * Where it lives — the host's secret store, the scoped person's vault row, or a
 * runner's lease — is the vault's choice (docs/plans/access-model.md §2.6).
 */
export interface GithubStoredToken {
  accessToken: string
  scope: string
  /** Cached from the first authenticated `/user` call so status() is offline-cheap. */
  login?: string
}

export const githubStoredTokenSchema = z.object({
  accessToken: z.string(),
  scope: z.string(),
  login: z.string().optional(),
})

const GITHUB: ProviderRef = { kind: 'provider', provider: 'github' }

/** Paired devices' credentials, by device id. */
export interface GithubDelegations {
  load(deviceId: string): GithubDelegatedCredential | null
  save(deviceId: string, credential: GithubDelegatedCredential): void
  clear(deviceId: string): void
}

export interface GitHubCredentialsDeps {
  /** The vault that keeps a person's GitHub login. */
  vault: () => Vault
  /** What `gh auth token` prints for `host`; rejects when `gh` is missing or signed out. */
  ghToken: (host: string) => Promise<string>
  delegations: GithubDelegations
  /** The paired device whose dispatch checkout `cwd` is, or null. */
  checkoutOwnerOf: (cwd: string) => Promise<string | null>
}

/** One place a credential of the chain is read from. A failed read of an `optional` source leaves it out; any other failure fails the chain. */
interface Source {
  from: GithubCredentialSource
  optional: boolean
}

/** `--hostname` names the account, so `gh` needs no checkout to run in — but
 *  `execFile` still needs a directory that exists. */
const ANY_DIRECTORY = homedir()

const GH_TIMEOUT_MS = 15_000

/** How long one answer from `gh auth token` stands. Long enough that a page of
 *  reads spawns `gh` once, short enough that a `gh auth login` is noticed. */
const GH_TOKEN_TTL_MS = 5 * 60_000

/** The actual granted scopes are the source of truth (the token exchange returns
 *  them in `scope`), so derive them from the stored token rather than the
 *  *requested* scopes — a user who connected before `project` existed has
 *  only `repo`, and the UI must reflect that to offer a reconnect. GitHub returns
 *  scopes comma-separated; tolerate whitespace too for safety. */
function toStatus(token: GithubStoredToken | null): AuthStatus {
  if (!token) return { connected: false }
  return {
    connected: true,
    login: token.login,
    scopes: token.scope ? parseGithubScopes(token.scope) : undefined,
  }
}

export class GitHubCredentials implements ProviderAuth {
  /** One device flow per person: on the workspace service several people may be connecting at once (cloud-service-model.md §22). */
  private readonly connecting = new Map<string, AbortController>()
  private readonly ghTokenByHost = new Map<string, { token: Promise<string | null>; readAt: number }>()

  constructor(private readonly deps: GitHubCredentialsDeps) {}

  /**
   * The whole policy (docs/plans/access-model.md §2.6), most specific first:
   *
   * - `delegated`: the paired device whose dispatch checkout `cwd` is. Its
   *   checkout is configured to commit and push as that device, so its API
   *   calls must be the device's too. No delegation means no client identity
   *   was ever written — `configureDelegatedCheckout` stores both in one step —
   *   and the work is the host's.
   * - `host` / `account`: the person's own login where the vault keeps it — this
   *   host's store, or their account once they are signed in.
   * - `gh-cli`: whatever `gh` is signed in as. `gh` is a credential, not a
   *   transport: its token drives the same REST and GraphQL client as the
   *   others. It is a runtime login of this machine, so only the host's own work
   *   and the owner of this machine use it.
   *
   * The machine owner signed in keeps `gh` when their account does not answer.
   * A member has their account alone, and a failed read of it is their error.
   * A guest has nothing.
   */
  private sourcesFor(personKey: string | null): Source[] {
    const location = credentialLocationOf(personKey)
    if (location.kind === 'host') {
      return [{ from: 'delegated', optional: false }, { from: 'host', optional: true }, { from: 'gh-cli', optional: false }]
    }
    if (isMachineOwner(personKey)) {
      return [{ from: 'delegated', optional: false }, { from: 'account', optional: true }, { from: 'gh-cli', optional: false }]
    }
    if (location.kind === 'account') return [{ from: 'account', optional: false }]
    return []
  }

  /**
   * Every credential that may act on `host`, in `sourcesFor` order. A request
   * runs down this list until GitHub accepts one credential; see
   * `runGithubRequest`. An empty chain means GitHub is not reachable from this
   * host by any means.
   */
  async chain(host: string, cwd?: string): Promise<GithubCredential[]> {
    const personKey = currentPersonKey()
    const chain: GithubCredential[] = []
    for (const { from, optional } of this.sourcesFor(personKey)) {
      const read = this.read(from, personKey, host, cwd)
      const token = optional
        ? await read.catch((error) => {
          if (from === 'account') log.warn('github_account_token_unreadable', { error: error instanceof Error ? error.message : String(error) })
          return null
        })
        : await read
      if (token) chain.push({ source: from, token })
    }
    return chain
  }

  /** REST and GraphQL clients in the one GitHub credential order. */
  async clients(host: string, cwd?: string): Promise<GitHubClient[]> {
    return (await this.chain(host, cwd)).map(clientFor)
  }

  /** The current person's own GitHub login where the vault keeps it: this host's store or their account. */
  accountToken(): Promise<GithubStoredToken | null> {
    return this.deps.vault().read(currentPersonKey(), GITHUB, githubStoredTokenSchema)
  }

  /** Forgets the current person's login on this host. */
  async clear(): Promise<void> {
    this.deps.vault().remove(currentPersonKey(), GITHUB)
  }

  /** A paired device's delegated credential, as served by `solus git-credential`. */
  delegated(deviceId: string): string | null {
    try {
      return this.deps.delegations.load(deviceId)?.accessToken ?? null
    } catch {
      return null
    }
  }

  /** Keeps a paired device's credential for its dispatch checkouts. */
  delegate(deviceId: string, credential: GithubDelegatedCredential): void {
    this.deps.delegations.save(deviceId, credential)
  }

  /** Forgets a revoked device's credential. */
  revokeDelegation(deviceId: string): void {
    this.deps.delegations.clear(deviceId)
  }

  async connect(onUserCode: (c: DeviceCodePrompt) => void): Promise<AuthStatus> {
    if (usesAccountIntegration()) throw new Error('Connect GitHub on your account website.')
    if (!GITHUB_CLIENT_ID) throw new Error('GitHub client ID not configured')
    // The scope set at dispatch carries through every await below, so the token
    // lands in the caller's own store; the key only serializes their attempts.
    const who = currentPersonKey() ?? 'host'
    if (this.connecting.has(who)) throw new Error('A GitHub connection is already in progress.')
    const abort = new AbortController()
    this.connecting.set(who, abort)
    try {
      const token = await authorizeWithDeviceFlow(onUserCode, abort.signal)
      this.deps.vault().save(currentPersonKey(), GITHUB, token)
      return toStatus(token)
    } finally {
      this.connecting.delete(who)
    }
  }

  cancelConnect(): void {
    this.connecting.get(currentPersonKey() ?? 'host')?.abort()
  }

  async getAccessToken(): Promise<string> {
    const token = await this.accountToken()
    if (!token) throw new Error('GitHub is not connected')
    return token.accessToken
  }

  async status(): Promise<AuthStatus> {
    return toStatus(await this.accountToken())
  }

  async hasCredential(host: string, cwd?: string): Promise<boolean> {
    return (await this.chain(host, cwd)).length > 0
  }

  async disconnect(): Promise<void> {
    await this.clear()
    log.info('github_disconnected')
  }

  private async read(from: GithubCredentialSource, personKey: string | null, host: string, cwd: string | undefined): Promise<string | null> {
    switch (from) {
      case 'delegated': {
        const ownerKey = cwd ? await this.deps.checkoutOwnerOf(cwd) : null
        return ownerKey ? this.delegated(ownerKey) : null
      }
      case 'host':
        return (await this.deps.vault().read(personKey, GITHUB, githubStoredTokenSchema))?.accessToken ?? null
      case 'account':
        // The account holds a github.com login only.
        if (host !== 'github.com') return null
        return (await this.deps.vault().read(personKey, GITHUB, githubStoredTokenSchema))?.accessToken ?? null
      case 'gh-cli':
        return this.ghToken(host)
    }
  }

  /** The credential `gh` is signed in with for `host`, or null when `gh` is
   *  missing, signed out, or does not know the host. */
  private ghToken(host: string): Promise<string | null> {
    const cached = this.ghTokenByHost.get(host)
    if (cached && Date.now() - cached.readAt < GH_TOKEN_TTL_MS) return cached.token
    log.info('gh_credential_lookup_started', { host })
    const token = this.deps.ghToken(host)
      .then((output) => {
        if (output) return output
        log.warn('gh_credential_unavailable', { host, error: 'gh auth token returned no token' })
        return null
      })
      .catch((error) => {
        log.warn('gh_credential_unavailable', { host, error: error instanceof Error ? error.message : String(error) })
        return null
      })
    this.ghTokenByHost.set(host, { token, readAt: Date.now() })
    return token
  }
}

/** This host's sources: the installed vault, the machine's `gh`, and the delegations in its secret store. */
const HOST_DEPS: GitHubCredentialsDeps = {
  vault,
  ghToken: (host) => runAsync('gh', ['auth', 'token', '--hostname', host], ANY_DIRECTORY, { timeout: GH_TIMEOUT_MS }),
  delegations: { load: loadDelegation, save: saveDelegation, clear: clearDelegation },
  // The layout module is loaded on demand: it reaches the worktree manager and
  // the database, which a plain provider read has no business loading.
  checkoutOwnerOf: async (cwd) => {
    const { dispatchCheckoutOwnerKeyOf } = await import('../../project-config/dispatch-checkouts')
    return dispatchCheckoutOwnerKeyOf(cwd)
  },
}

let installed: GitHubCredentials | null = null

/** Installs this process's GitHub credentials; null removes it (tests). */
export function useGitHubCredentials(next: GitHubCredentials | null): void {
  installed = next
}

/** The GitHub credentials this process installed; before that, the one over this host's sources. */
export function githubCredentials(): GitHubCredentials {
  installed ??= new GitHubCredentials(HOST_DEPS)
  return installed
}
