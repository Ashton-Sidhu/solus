import { mock } from 'bun:test'

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

export function installGithubClientMock(): void {
  mock.module('@solus/server/providers/github/auth', () => ({
    GitHubAuth: class {
      async getAccessToken(): Promise<string> {
        return githubClientState.accessToken
      }

      async status(): Promise<{ connected: boolean; scopes: string[] }> {
        return { connected: true, scopes: [] }
      }
    },
  }))

  mock.module('@solus/server/providers/github/octokit', () => ({
    GitHubReauthRequiredError: class extends Error {},
    buildClient: async () => ({
      rest: { repos: { get: async () => ({ data: githubClientState.repository }) } },
    }),
  }))
}
