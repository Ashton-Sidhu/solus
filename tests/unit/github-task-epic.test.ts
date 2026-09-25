import { describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { GitHubClient } from '@solus/server/providers/github/octokit'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const { GitHubTaskProvider } = await import('@solus/server/tasks/providers/github')

function issue(parent: { number: number; title: string; url: string; body?: string } | null) {
  return {
    number: 7,
    title: 'Ship the thing',
    body: 'Body',
    state: 'OPEN',
    url: 'https://github.com/acme/app/issues/7',
    updatedAt: '2026-08-01T10:00:00Z',
    labels: { nodes: [] },
    assignees: { nodes: [] },
    parent,
  }
}

/** A provider whose one client answers every GraphQL read with `answer`, and
 *  records the documents it was asked. */
function providerAnswering(answer: (query: string) => unknown) {
  const queries: string[] = []
  const client = {
    graphql: async (query: string) => {
      queries.push(query)
      return answer(query)
    },
    credential: { source: 'host', token: 'gho_test' },
  } as unknown as GitHubClient
  class TestProvider extends GitHubTaskProvider {
    protected override clients(): Promise<GitHubClient[]> {
      return Promise.resolve([client])
    }
  }
  return { provider: new TestProvider({ host: 'github.com', owner: 'acme', repo: 'app' }), queries }
}

describe('the GitHub parent issue as the epic', () => {
  test('a detail read maps the parent with its title, url, and description', async () => {
    // WHY: the agent gets the epic's description as context, and the rail
    // links the epic. Both come from the one issue read.
    const parent = { number: 3, title: 'Release 2.0', url: 'https://github.com/acme/app/issues/3', body: 'Every client in one week.' }
    const { provider } = providerAnswering(() => ({ repository: { issue: issue(parent) } }))

    expect((await provider.getTask('7')).epic).toEqual({
      provider: 'github',
      externalId: '3',
      url: 'https://github.com/acme/app/issues/3',
      title: 'Release 2.0',
      body: 'Every client in one week.',
    })
  })

  test('an issue with no parent has no epic', async () => {
    const { provider } = providerAnswering(() => ({ repository: { issue: issue(null) } }))
    expect((await provider.getTask('7')).epic).toBeUndefined()
  })

  test('a list read names the epic without asking for its description', async () => {
    // WHY: a list carries up to 200 issues. Selecting every parent's body would
    // ship one epic description per row that no list surface shows.
    const parent = { number: 3, title: 'Release 2.0', url: 'https://github.com/acme/app/issues/3' }
    const { provider, queries } = providerAnswering(() => ({
      repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [issue(parent)] } },
    }))

    const { tasks } = await provider.listTasks()
    expect(tasks[0]?.epic).toEqual({ provider: 'github', externalId: '3', url: parent.url, title: 'Release 2.0', body: '' })
    expect(queries[0]).toContain('parent { number title url }')
    expect(queries[0]).not.toContain('parent { body }')
  })
})
