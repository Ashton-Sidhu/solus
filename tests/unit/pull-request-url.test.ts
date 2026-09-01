import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { join } from 'path'

const root = join(import.meta.dir, '../..')

describe('pull request URL resolution', () => {
  test('falls back to gh after the provider adapter fails', () => {
    // WHY: number-only task links still need one canonical URL, and remote
    // clients cannot run the host CLI from the renderer.
    const script = String.raw`
      import { mock } from 'bun:test'

      const calls = []
      mock.module('./packages/server/src/git/git-helpers', () => ({
        resolveRepoRef: async () => ({ host: 'github.com', owner: 'solus-sh', repo: 'solus' }),
      }))
      mock.module('./packages/server/src/providers/registry', () => ({
        providerForRepo: () => ({
          review: {
            getPullRequest: async () => { throw new Error('adapter unavailable') },
          },
        }),
      }))
      mock.module('./packages/server/src/git/exec', () => ({
        runAsync: async (bin, args, cwd, options) => {
          calls.push({ bin, args, cwd, options })
          return 'https://github.com/solus-sh/solus/pull/135'
        },
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
    expect(run.stderr).toContain('provider_adapter_failed')
    expect(run.stdout).toContain('provider_cli_fallback_succeeded')
    const output = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as {
      calls: Array<{ bin: string; args: string[]; cwd: string; options: { timeout: number } }>
      url: string
    }
    expect(output).toEqual({
      calls: [{
        bin: 'gh',
        args: ['pr', 'view', '135', '--json', 'url', '--jq', '.url'],
        cwd: '/repo',
        options: { timeout: 10_000 },
      }],
      url: 'https://github.com/solus-sh/solus/pull/135',
    })
  })
})
