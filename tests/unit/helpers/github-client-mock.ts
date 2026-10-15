import { mock } from 'bun:test'
import { isGithubCredentialAccessFailure, type GitHubClient } from '@solus/server/providers/github/octokit'
import { useGitHubCredentials } from '@solus/server/providers/github/credentials'
import { fakeGithubCredentials } from './github-credentials'

/**
 * Bun registers a module mock for the whole test run, not per file. Two files
 * that each mock the GitHub client would otherwise overwrite one another, and
 * the loser would see a stub built for someone else's assertions. So the mock
 * lives here: every caller installs the same implementation over the same
 * mutable state, and registration order stops mattering.
 */

export type RepositoryPermission = 'admin' | 'maintain' | 'write' | 'read'

export interface MockedRepository {
  id: number
  permissions: { admin: boolean; maintain: boolean; push: boolean }
}

export function mockedRepository(permission: RepositoryPermission, id = 1234): MockedRepository {
  return {
    id,
    permissions: {
      admin: permission === 'admin',
      maintain: permission === 'maintain',
      push: permission === 'write',
    },
  }
}

/** What `rest.repos.get` answers. Reassign it to change the permission a test sees. */
export const githubClientState = {
  repository: mockedRepository('write'),
  accessToken: 'gho_test-token',
}

/** The client every mocked builder hands out: one repository read, signed
 *  with the host's token. */
export function mockedGithubClient(): GitHubClient {
  return {
    rest: { repos: { get: async () => ({ data: githubClientState.repository }) } },
    credential: { source: 'host', token: githubClientState.accessToken },
  } as unknown as GitHubClient
}

export function installGithubClientMock(): void {
  // Signed with the host's token: the host's own work is connected to GitHub.
  useGitHubCredentials(fakeGithubCredentials({ hostToken: githubClientState.accessToken }).credentials)

  mock.module('@solus/server/providers/github/octokit', () => ({
    GitHubReauthRequiredError: class extends Error {},
    isGithubCredentialAccessFailure,
    buildClient: async () => mockedGithubClient(),
    clientFor: () => mockedGithubClient(),
  }))
}
