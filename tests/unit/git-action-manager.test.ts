import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { join } from 'path'

const root = join(import.meta.dir, '../..')

describe('Git action manager', () => {
  test('creates a semantic branch and reuses the pull request found after push', () => {
    const script = String.raw`
      import { mock } from 'bun:test'

      const calls = []
      const events = []
      let generatedSubjects = 0
      mock.module('./packages/server/src/git/exec', () => ({
        runAsync: async (bin, args) => {
          calls.push({ bin, args })
          if (bin === 'gh') return JSON.stringify({
            url: 'https://github.com/solus-sh/solus/pull/51',
            number: 51,
            title: 'Publish Git actions',
          })
          if (args[0] === 'status') return ' M src/git.ts'
          if (args[0] === 'diff' && args.includes('--diff-filter=U')) return ''
          if (args[0] === 'rev-parse' && args.includes('@{upstream}')) throw new Error('No upstream')
          if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'abc123'
          if (args[0] === 'for-each-ref') return ''
          return ''
        },
      }))

      const { runGitAction } = await import('./packages/server/src/git/git-action-manager')
      const result = await runGitAction(
        {
          actionId: 'action-branch',
          action: 'commit_push_pull_request',
          createFeatureBranch: true,
        },
        { branch: 'main', targetBranch: 'main' },
        '/tmp/solus-semantic-branch',
        {
          generateCommitSubject: async () => {
            generatedSubjects++
            return 'feat(git): publish Git actions'
          },
          publish: (event) => events.push(event),
          writer: {
            provider: 'codex',
            textGenerator: { generate: async () => '' },
            instructions: 'Follow repository conventions.',
            followPullRequestTemplate: true,
          },
        },
      )
      console.log(JSON.stringify({ calls, events, generatedSubjects, result }))
    `
    const run = spawnSync(process.execPath, ['-e', script], {
      cwd: root,
      encoding: 'utf8',
    })

    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    // SAFETY: The child script serializes this exact result shape above.
    const output = JSON.parse(run.stdout) as {
      calls: Array<{ bin: string; args: string[] }>
      events: Array<{ kind: string; phase?: string }>
      generatedSubjects: number
      result: {
        branch: { status: string; name: string }
        commit: { status: string; subject: string }
        pullRequest: { status: string; url: string }
      }
    }
    expect(output.generatedSubjects).toBe(1)
    expect(output.calls.find((call) => call.args[0] === 'checkout')?.args).toEqual([
      'checkout',
      '-b',
      'feature/publish-git-actions',
    ])
    expect(output.result.branch).toEqual({ status: 'created', name: 'feature/publish-git-actions' })
    expect(output.result.commit).toMatchObject({
      status: 'created',
      subject: 'feat(git): publish Git actions',
    })
    expect(output.result.pullRequest).toEqual({
      status: 'existing',
      url: 'https://github.com/solus-sh/solus/pull/51',
      number: 51,
      title: 'Publish Git actions',
    })
    expect(output.events.filter((event) => event.kind === 'phase_started').map((event) => event.phase)).toEqual([
      'branch',
      'commit',
      'push',
      'author_pull_request',
    ])
    expect(output.calls.filter((call) => call.bin === 'gh')).toHaveLength(1)
  })

  test('falls back to the GitHub CLI when Octokit cannot create the pull request', () => {
    const script = String.raw`
      import { mock } from 'bun:test'

      const calls = []
      mock.module('./packages/server/src/git/exec', () => ({
        runAsync: async (bin, args) => {
          calls.push({ bin, args })
          if (bin === 'gh' && args[1] === 'view') throw new Error('No pull request exists')
          if (bin === 'gh' && args[1] === 'create') {
            return 'https://github.com/solus-sh/solus/pull/72'
          }
          if (args[0] === 'status') return ''
          if (args[0] === 'rev-parse' && args.includes('@{upstream}')) return 'origin/feature/fallback'
          if (args[0] === 'rev-parse' && args[1] === '--verify') return 'abc123'
          if (args[0] === 'rev-list') return '1'
          if (args[0] === 'remote') return 'https://github.com/solus-sh/solus.git'
          if (args[0] === 'log') return 'fix(git): fall back to GitHub CLI'
          if (args[0] === 'diff' && args.includes('--stat')) return 'src/git.ts | 5 +++++'
          if (args[0] === 'diff') return 'diff --git a/src/git.ts b/src/git.ts'
          if (args[0] === 'show') return ''
          return ''
        },
      }))

      const octokitCalls = []
      const githubClient = {
        rest: {
          pulls: {
            create: async (request) => {
              octokitCalls.push(request)
              throw new Error('Resource not accessible by integration')
            },
          },
        },
      }
      const { runGitAction } = await import('./packages/server/src/git/git-action-manager')
      const result = await runGitAction(
        { actionId: 'action-fallback', action: 'create_pull_request' },
        { branch: 'feature/fallback', targetBranch: 'main' },
        '/tmp/solus-pr-fallback',
        {
          githubClient,
          githubRepo: { host: 'github.com', owner: 'solus-sh', repo: 'solus' },
          githubToken: 'checkout-token',
          generateCommitSubject: async () => 'unused',
          publish: () => {},
          writer: {
            provider: 'codex',
            instructions: 'Use Conventional Commits.',
            followPullRequestTemplate: true,
            textGenerator: {
              generate: async (options) => {
                await options.tools[0].execute({
                  title: 'fix(git): fall back to GitHub CLI',
                  body: '## Summary\n\n- Fall back when the API fails.\n\n## Testing\n\n- Unit test',
                })
                return ''
              },
            },
          },
        },
      )
      console.log(JSON.stringify({ calls, octokitCalls, result }))
    `
    const run = spawnSync(process.execPath, ['-e', script], {
      cwd: root,
      encoding: 'utf8',
    })

    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    // SAFETY: The child script serializes this exact result shape above.
    const output = JSON.parse(run.stdout) as {
      calls: Array<{ bin: string; args: string[] }>
      octokitCalls: Array<{ owner: string; repo: string; base: string; head: string }>
      result: { pullRequest: { status: string; url: string; number: number; title: string } }
    }
    expect(output.octokitCalls).toEqual([{
      owner: 'solus-sh',
      repo: 'solus',
      base: 'main',
      head: 'feature/fallback',
      title: 'fix(git): fall back to GitHub CLI',
      body: '## Summary\n\n- Fall back when the API fails.\n\n## Testing\n\n- Unit test',
    }])
    expect(output.calls.some((call) => call.bin === 'gh' && call.args[1] === 'create')).toBe(true)
    expect(output.result.pullRequest).toEqual({
      status: 'created',
      url: 'https://github.com/solus-sh/solus/pull/72',
      number: 72,
      title: 'fix(git): fall back to GitHub CLI',
    })
  })
})
