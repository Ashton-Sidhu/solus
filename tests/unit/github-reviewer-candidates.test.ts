import { describe, expect, test } from 'bun:test'
import { Octokit } from '@octokit/rest'
import type { GitHubClient } from '../../packages/server/src/providers/github/octokit'
import { listGithubReviewerCandidates } from '../../packages/server/src/providers/github/pull-request-actions'

const repo = { host: 'github.com', owner: 'example', repo: 'project' }

function fixtureClient(failSecondPage = false) {
  const pages: number[] = []
  const client: GitHubClient = {
    credential: { source: 'host', token: 'fixture' },
    graphql: async () => { throw new Error('Unexpected GraphQL request') },
    rest: new Octokit({
      request: {
        fetch: async (input: string | URL | Request) => {
          const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
          const page = Number(url.searchParams.get('page') ?? 1)
          pages.push(page)
          if (page === 2 && failSecondPage) {
            return Response.json({ message: 'Forbidden' }, { status: 403 })
          }
          const users = page === 1
            ? Array.from({ length: 100 }, (_, index) => ({ login: `user-${index}`, avatar_url: `https://example.test/${index}` }))
            : [{ login: 'late-reviewer', avatar_url: 'https://example.test/late' }, { login: 'AUTHOR', avatar_url: '' }]
          return Response.json(users, {
            headers: page === 1 ? {
              link: '<https://api.github.com/repos/example/project/collaborators?affiliation=all&per_page=100&page=2>; rel="next"',
            } : {},
          })
        },
      },
    }),
  }
  return { client, pages }
}

describe('reviewer candidates', () => {
  test('includes collaborators beyond the first page and excludes the author on later pages', async () => {
    const { client, pages } = fixtureClient()
    const candidates = await listGithubReviewerCandidates(client, repo, 'author')
    expect(pages).toEqual([1, 2])
    expect(candidates).toHaveLength(101)
    expect(candidates).toContainEqual({ login: 'late-reviewer', avatarUrl: 'https://example.test/late' })
    expect(candidates.some(({ login }) => login.toLowerCase() === 'author')).toBe(false)
  })

  test('reports a later page failure instead of returning an incomplete reviewer list', async () => {
    const { client } = fixtureClient(true)
    await expect(listGithubReviewerCandidates(client, repo, 'author')).rejects.toThrow('Forbidden')
  })
})
