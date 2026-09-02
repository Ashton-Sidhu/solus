import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { join } from 'path'

const root = join(import.meta.dir, '../..')

describe('pull request URL resolution', () => {
  test('uses the provider credential chain and validates its canonical URL', () => {
    // WHY: number-only task links must use the same credential selection as
    // every other GitHub surface instead of starting a separate gh command.
    const script = String.raw`
      import { mock } from 'bun:test'

      const calls = []
      mock.module('./packages/server/src/git/git-helpers', () => ({
        resolveRepoRef: async () => ({ host: 'github.com', owner: 'solus-sh', repo: 'solus' }),
      }))
      mock.module('./packages/server/src/providers/registry', () => ({
        providerForRepo: () => ({
          review: {
            getPullRequest: async (repo, number) => {
              calls.push({ repo, number })
              return { url: 'https://github.com/solus-sh/solus/pull/135' }
            },
          },
        }),
      }))

      const { resolvePullRequestUrl } = await import('./packages/server/src/providers/pull-request-url')
      const url = await resolvePullRequestUrl('/repo', 135)
      console.log(JSON.stringify({ calls, url }))
    `
    const run = spawnSync(process.execPath, ['-e', script], {
      cwd: root,
      encoding: 'utf8',
    })

    expect(run.status).toBe(0)
    const output = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as {
      calls: Array<{ repo: { host: string; owner: string; repo: string }; number: number }>
      url: string
    }
    expect(output).toEqual({
      calls: [{
        repo: { host: 'github.com', owner: 'solus-sh', repo: 'solus' },
        number: 135,
      }],
      url: 'https://github.com/solus-sh/solus/pull/135',
    })
  })
})
