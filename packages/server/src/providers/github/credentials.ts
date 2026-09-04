import { homedir } from 'node:os'
import { runAsync } from '../../git/exec'
import { createLogger } from '../../logger'
import { loadDelegation } from './delegation-store'
import { loadToken } from './token-store'

/**
 * The one place that decides which GitHub credential an operation acts with.
 * `token-store` and `delegation-store` are this module's implementation — read
 * them from here, not directly, so the policy cannot fork again.
 */

const log = createLogger('main', 'github-credentials')

export type GithubCredentialSource = 'delegated' | 'host' | 'gh-cli'

export interface GithubCredential {
  source: GithubCredentialSource
  token: string
}

/** The account this host is connected as. */
export function hostGithubToken(): string | null {
  try {
    return loadToken()?.accessToken ?? null
  } catch {
    return null
  }
}

/** A paired device's delegated credential, as served by `solus git-credential`. */
export function delegatedGithubToken(deviceId: string): string | null {
  try {
    return loadDelegation(deviceId)?.accessToken ?? null
  } catch {
    return null
  }
}

/**
 * The paired device's credential when `cwd` is inside its dispatch checkout.
 * The layout module is loaded on demand: it reaches the worktree manager and
 * the database, which a plain provider read has no business loading.
 */
async function delegatedCheckoutToken(cwd: string): Promise<string | null> {
  const { dispatchCheckoutDeviceId } = await import('../../project-config/dispatch-checkouts')
  const deviceId = dispatchCheckoutDeviceId(cwd)
  return deviceId ? delegatedGithubToken(deviceId) : null
}

/** `--hostname` names the account, so `gh` needs no checkout to run in — but
 *  `execFile` still needs a directory that exists. */
const ANY_DIRECTORY = homedir()

const GH_TIMEOUT_MS = 15_000

/** How long one answer from `gh auth token` stands. Long enough that a page of
 *  reads spawns `gh` once, short enough that a `gh auth login` is noticed. */
const GH_TOKEN_TTL_MS = 5 * 60_000

const ghTokenByHost = new Map<string, { token: Promise<string | null>; readAt: number }>()

/** The credential `gh` is signed in with for `host`, or null when `gh` is
 *  missing, signed out, or does not know the host. */
function ghCliGithubToken(host: string): Promise<string | null> {
  const cached = ghTokenByHost.get(host)
  if (cached && Date.now() - cached.readAt < GH_TOKEN_TTL_MS) return cached.token
  log.info('gh_credential_lookup_started', { host })
  const token = runAsync('gh', ['auth', 'token', '--hostname', host], ANY_DIRECTORY, { timeout: GH_TIMEOUT_MS })
    .then((output) => {
      if (output) return output
      log.warn('gh_credential_unavailable', { host, error: 'gh auth token returned no token' })
      return null
    })
    .catch((error) => {
      log.warn('gh_credential_unavailable', { host, error: error instanceof Error ? error.message : String(error) })
      return null
    })
  ghTokenByHost.set(host, { token, readAt: Date.now() })
  return token
}

/**
 * Every credential that may act on `host`, most specific first:
 *
 * 1. The paired device whose dispatch checkout `cwd` is. Its checkout is
 *    configured to commit and push as that device, so its API calls must be
 *    the device's too. No delegation means no client identity was ever
 *    written — `configureDelegatedCheckout` stores both in one step — and the
 *    work is the host's.
 * 2. The account this host is connected as.
 * 3. Whatever `gh` is signed in as. `gh` is a credential, not a transport: its
 *    token drives the same REST and GraphQL client as the others, so a read
 *    answers identically whichever credential signed it.
 *
 * A request runs down this list until GitHub accepts one credential; see
 * `GitHubProvider.withClient`. An empty chain means GitHub is not reachable
 * from this host by any means.
 */
export async function githubCredentialChain(host: string, cwd?: string): Promise<GithubCredential[]> {
  const chain: GithubCredential[] = []
  const delegated = cwd ? await delegatedCheckoutToken(cwd) : null
  if (delegated) chain.push({ source: 'delegated', token: delegated })
  const hostToken = hostGithubToken()
  if (hostToken) chain.push({ source: 'host', token: hostToken })
  const cliToken = await ghCliGithubToken(host)
  if (cliToken) chain.push({ source: 'gh-cli', token: cliToken })
  return chain
}
