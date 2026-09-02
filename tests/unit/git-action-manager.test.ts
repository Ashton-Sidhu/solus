import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { join } from 'path'

const root = join(import.meta.dir, '../..')

describe('Git action manager', () => {
  test('reuses the provider pull request found after push', () => {
    const script = String.raw`
      import { mock } from 'bun:test'
      const calls = []
      const events = []
      mock.module('./packages/server/src/git/exec', () => ({
        runAsync: async (bin, args) => {
          calls.push({ bin, args })
          if (args[0] === 'status') return ' M src/git.ts'
          if (args[0] === 'diff' && args.includes('--diff-filter=U')) return ''
          if (args[0] === 'rev-parse' && args.includes('@{upstream}')) throw new Error('No upstream')
          if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'abc123'
          if (args[0] === 'for-each-ref') return ''
          return ''
        },
      }))
      const providerPullRequest = {
        url: 'https://github.com/solus-sh/solus/pull/51',
        number: 51,
        title: 'Publish Git actions',
      }
      const { runGitAction } = await import('./packages/server/src/git/git-action-manager')
      const result = await runGitAction(
        { actionId: 'action-branch', action: 'commit_push_pull_request', createFeatureBranch: true },
        { branch: 'main', targetBranch: 'main' },
        '/tmp/solus-semantic-branch',
        {
          generateCommitSubject: async () => 'feat(git): publish Git actions',
          findPullRequest: async () => providerPullRequest,
          publish: (event) => events.push(event),
          writer: {
            provider: 'codex',
            textGenerator: { generate: async () => '' },
            instructions: 'Follow repository conventions.',
            followPullRequestTemplate: true,
          },
        },
      )
      console.log(JSON.stringify({ calls, events, providerPullRequest, result }))
    `
    const run = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' })

    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    const output = JSON.parse(run.stdout) as {
      calls: Array<{ bin: string; args: string[] }>
      events: Array<{ kind: string; phase?: string }>
      providerPullRequest: { url: string; number: number; title: string }
      result: { pullRequest: { status: string; pullRequest: { url: string; number: number; title: string } } }
    }
    expect(output.result.pullRequest.status).toBe('existing')
    expect(output.result.pullRequest.pullRequest).toEqual(output.providerPullRequest)
    expect(output.events.filter((event) => event.kind === 'phase_started').map((event) => event.phase)).toEqual([
      'branch',
      'commit',
      'push',
      'author_pull_request',
    ])
    expect(output.calls.filter((call) => call.bin === 'gh')).toHaveLength(0)
  })

  test('creates through the provider and carries the provider record', () => {
    const script = String.raw`
      import { mock } from 'bun:test'
      const calls = []
      const createInputs = []
      mock.module('./packages/server/src/git/exec', () => ({
        runAsync: async (bin, args) => {
          calls.push({ bin, args })
          if (args[0] === 'status') return ''
          if (args[0] === 'rev-parse' && args.includes('@{upstream}')) return 'origin/feature/provider'
          if (args[0] === 'rev-parse' && args[1] === '--verify') return 'abc123'
          if (args[0] === 'rev-list') return '1'
          if (args[0] === 'remote') return 'https://github.com/solus-sh/solus.git'
          if (args[0] === 'log') return 'fix(git): use credential fallback'
          if (args[0] === 'diff' && args.includes('--stat')) return 'src/git.ts | 5 +++++'
          if (args[0] === 'diff') return 'diff --git a/src/git.ts b/src/git.ts'
          if (args[0] === 'show') return ''
          return ''
        },
      }))
      const providerPullRequest = {
        url: 'https://github.com/solus-sh/solus/pull/72',
        number: 72,
        title: 'fix(git): use credential fallback',
        headRef: 'feature/provider',
      }
      const { runGitAction } = await import('./packages/server/src/git/git-action-manager')
      const result = await runGitAction(
        { actionId: 'action-provider', action: 'create_pull_request' },
        { branch: 'feature/provider', targetBranch: 'main' },
        '/tmp/solus-pr-provider',
        {
          findPullRequest: async () => null,
          createPullRequest: async (input) => {
            createInputs.push(input)
            return providerPullRequest
          },
          generateCommitSubject: async () => 'unused',
          publish: () => {},
          writer: {
            provider: 'codex',
            instructions: 'Use Conventional Commits.',
            followPullRequestTemplate: true,
            textGenerator: {
              generate: async (options) => {
                await options.tools[0].execute({
                  title: 'fix(git): use credential fallback',
                  body: '## Summary\n\n- Use one credential chain.\n\n## Testing\n\n- Unit test',
                })
                return ''
              },
            },
          },
        },
      )
      console.log(JSON.stringify({ calls, createInputs, providerPullRequest, result }))
    `
    const run = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' })

    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    const output = JSON.parse(run.stdout) as {
      calls: Array<{ bin: string; args: string[] }>
      createInputs: Array<{ baseRef: string; headRef: string; title: string; body: string }>
      providerPullRequest: { url: string; number: number; title: string; headRef: string }
      result: { pullRequest: { status: string; pullRequest: { url: string; number: number; title: string; headRef: string } } }
    }
    expect(output.createInputs).toEqual([{
      baseRef: 'main',
      headRef: 'feature/provider',
      title: 'fix(git): use credential fallback',
      body: '## Summary\n\n- Use one credential chain.\n\n## Testing\n\n- Unit test',
    }])
    expect(output.result.pullRequest.status).toBe('created')
    expect(output.result.pullRequest.pullRequest).toEqual(output.providerPullRequest)
    expect(output.calls.filter((call) => call.bin === 'gh')).toHaveLength(0)
  })
})
