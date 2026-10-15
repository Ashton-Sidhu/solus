import type { GithubDelegatedCredential } from '@solus/contracts/types'
import { GitHubCredentials, type GitHubCredentialsDeps } from '@solus/server/providers/github/credentials'
import type { SecretStore } from '@solus/server/platform/secrets'
import { Vault } from '@solus/server/vault/vault'

/**
 * `GitHubCredentials` over scripted sources: no keyring, no `gh`, no database.
 * Every source is empty unless the test names it.
 */
export interface FakeGithubSources {
  /** The login in this host's store. */
  hostToken?: string | null
  /** What the account answers for a person's login read. */
  account?: (accountId: string) => Response | { refused: 'NO_DELEGATION'; message: string }
  /** `gh auth token`, by host; a host it does not name is signed out. */
  gh?: Map<string, string>
  delegations?: Map<string, GithubDelegatedCredential>
  /** The paired device whose dispatch checkout every `cwd` is. */
  checkoutOwner?: string | null
}

export interface FakeGithubCredentials {
  credentials: GitHubCredentials
  /** The hosts `gh` was asked about, in order. */
  ghCalls: string[]
}

export function fakeGithubCredentials(sources: FakeGithubSources = {}): FakeGithubCredentials {
  const ghCalls: string[] = []
  const secrets: SecretStore = {
    canSave: () => true,
    loadJson: (key, _path, schema) => key === 'github-oauth' && sources.hostToken
      ? schema.parse({ accessToken: sources.hostToken, scope: 'repo' })
      : null,
    saveJson: () => {},
    remove: () => {},
  }
  const vault = new Vault({
    secrets,
    reads: {
      fetch: async (accountId) => sources.account?.(accountId) ?? new Response('not connected', { status: 404 }),
    },
  })
  const deps: GitHubCredentialsDeps = {
    vault: () => vault,
    ghToken: async (host) => {
      ghCalls.push(host)
      const token = sources.gh?.get(host)
      if (!token) throw new Error('gh: not logged in to any hosts')
      return token
    },
    delegations: {
      load: (deviceId) => sources.delegations?.get(deviceId) ?? null,
      save: (deviceId, credential) => { sources.delegations?.set(deviceId, credential) },
      clear: (deviceId) => { sources.delegations?.delete(deviceId) },
    },
    checkoutOwnerOf: async () => sources.checkoutOwner ?? null,
  }
  return { credentials: new GitHubCredentials(deps), ghCalls }
}
