import { describe, expect, test } from 'bun:test'
import type { RepoRef } from '@solus/contracts/providers'
import type { GitHubClient } from '@solus/server/providers/github/octokit'
import { readGithubViewedFiles, writeGithubViewedFiles } from '@solus/server/providers/github/viewed-files'

const repo: RepoRef = { host: 'github.com', owner: 'acme', repo: 'app' }

interface Query { document: string; variables: { [name: string]: string | number | null } }

function graphqlGitHub(answer: (query: Query) => object): { client: GitHubClient; queries: Query[] } {
  const queries: Query[] = []
  const client = {
    rest: {},
    graphql: async (document: string, variables: Query['variables']) => {
      const query = { document, variables }
      queries.push(query)
      return answer(query)
    },
    credential: { source: 'host', token: 'test-token' },
  } as unknown as GitHubClient
  return { client, queries }
}

const filesPage = (nodes: object[], endCursor: string | null) => ({
  repository: { pullRequest: { files: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes } } },
})

describe('GitHub viewed files', () => {
  test('reads the viewer state of every file, page by page', async () => {
    const { client, queries } = graphqlGitHub(({ variables }) => variables.after === null
      ? filesPage([{ path: 'a.ts', viewerViewedState: 'VIEWED' }, { path: 'b.ts', viewerViewedState: 'DISMISSED' }], 'cursor-1')
      : filesPage([{ path: 'c.ts', viewerViewedState: 'UNVIEWED' }, { path: 'd.ts', viewerViewedState: 'SOMETHING_NEW' }], null))

    const viewed = await readGithubViewedFiles(client, repo, 7)

    expect(viewed).toEqual({
      complete: true,
      files: [
        { path: 'a.ts', state: 'viewed' },
        // WHY: dismissed means the file changed after the viewer marked it, so
        // a client shows it as needing another look, not as done.
        { path: 'b.ts', state: 'dismissed' },
        { path: 'c.ts', state: 'unviewed' },
        { path: 'd.ts', state: 'unviewed' },
      ],
    })
    expect(queries.map((query) => query.variables.after)).toEqual([null, 'cursor-1'])
  })

  test('says the list is not complete when the pull request has more files than one read takes', async () => {
    // WHY: a client must not show a file past the limit as unviewed when the
    // viewer marked it on GitHub.
    let page = 0
    const { client } = graphqlGitHub(() => filesPage([{ path: `f${page}.ts`, viewerViewedState: 'VIEWED' }], `cursor-${++page}`))

    const viewed = await readGithubViewedFiles(client, repo, 7)

    expect(viewed.complete).toBe(false)
    expect(viewed.files).toHaveLength(10)
  })

  test('sends the last change to each path, in one aliased mutation per batch', async () => {
    const { client, queries } = graphqlGitHub(({ document }) => document.includes('pullRequest(number: $number) { id }')
      ? { repository: { pullRequest: { id: 'PR_7' } } }
      : {})

    await writeGithubViewedFiles(client, repo, 7, [
      { path: 'a.ts', viewed: true },
      { path: 'b.ts', viewed: true },
      { path: 'a.ts', viewed: false },
    ])

    const mutation = queries[1]
    expect(queries).toHaveLength(2)
    expect(mutation.variables).toEqual({ pullRequestId: 'PR_7', p0: 'b.ts', p1: 'a.ts' })
    expect(mutation.document).toContain('f0: markFileAsViewed(input: { pullRequestId: $pullRequestId, path: $p0 })')
    expect(mutation.document).toContain('f1: unmarkFileAsViewed(input: { pullRequestId: $pullRequestId, path: $p1 })')
  })

  test('splits a large change into batches, and sends nothing for no change', async () => {
    const { client, queries } = graphqlGitHub(({ document }) => document.includes('{ id }')
      ? { repository: { pullRequest: { id: 'PR_7' } } }
      : {})

    await writeGithubViewedFiles(client, repo, 7, [])
    expect(queries).toHaveLength(0)

    await writeGithubViewedFiles(client, repo, 7, Array.from({ length: 120 }, (_, index) => ({ path: `f${index}.ts`, viewed: true })))
    expect(queries).toHaveLength(1 + 3)
  })
})
