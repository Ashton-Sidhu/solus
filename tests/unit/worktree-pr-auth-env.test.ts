import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { join } from 'path'

const root = join(import.meta.dir, '../..')

describe('Git action GitHub authentication', () => {
  test('always leaves GitHub CLI authentication to the CLI credential store', () => {
    const script = String.raw`
      import { mock } from 'bun:test'
      import { Database } from 'bun:sqlite'
      import { readFileSync } from 'fs'

      const calls = []
      const events = []
      let submittedBody = ''
      mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
      mock.module('./packages/server/src/git/exec', () => ({
        git: () => '',
        runAsync: async (bin, args, _cwd, options = {}) => {
          calls.push({ bin, args, env: options.env })
          if (bin === 'gh' && args[1] === 'view') throw new Error('No pull request exists')
          if (bin === 'gh' && args[1] === 'create') {
            submittedBody = readFileSync(args[args.indexOf('--body-file') + 1], 'utf8')
            return 'https://github.com/solus-sh/solus/pull/42'
          }
          if (args[0] === 'status') return ''
          if (args[0] === 'rev-parse' && args.includes('@{upstream}')) throw new Error('No upstream')
          if (args[0] === 'rev-list') return '1'
          if (args[0] === 'log') return 'feat(git): author complete pull requests'
          if (args[0] === 'diff' && args.includes('--stat')) return 'src/git.ts | 5 +++++'
          if (args[0] === 'diff') return 'diff --git a/src/git.ts b/src/git.ts'
          if (args[0] === 'show') return ''
          return ''
        },
      }))
      const { runGitAction } = await import('./packages/server/src/git/git-action-manager')
      const dispatchCheckout = '/Users/host/projects/solus-remote/dispatching-device/github.com/solus-sh/solus'
      const result = await runGitAction(
        { actionId: 'action-1', action: 'create_pull_request' },
        { branch: 'solus/dispatched-fix', targetBranch: 'main' },
        dispatchCheckout,
        {
          generateCommitSubject: async () => 'unused',
          publish: (event) => events.push(event),
          writer: {
            provider: 'codex',
            instructions: 'Use Conventional Commits.',
            followPullRequestTemplate: true,
            textGenerator: {
              generate: async (options) => {
                await options.tools[0].execute({
                  title: 'feat(git): author complete pull requests',
                  body: '## Summary\n\n- Author the pull request from the branch diff.\n\n## Testing\n\n- Not run',
                })
                return ''
              },
            },
          },
        },
      )
      console.log(JSON.stringify({ calls, events, result, submittedBody }))
    `
    const run = spawnSync(process.execPath, ['-e', script], {
      cwd: root,
      encoding: 'utf8',
    })

    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    // SAFETY: The child script serializes this exact result shape above.
    const output = JSON.parse(run.stdout) as {
      calls: Array<{ bin: string; args: string[]; env?: NodeJS.ProcessEnv }>
      events: Array<{ kind: string; phase?: string }>
      result: { pullRequest: { status: string; url: string; title: string } }
      submittedBody: string
    }
    expect(output.result.pullRequest).toEqual({
      status: 'created',
      url: 'https://github.com/solus-sh/solus/pull/42',
      number: 42,
      title: 'feat(git): author complete pull requests',
    })
    expect(output.submittedBody).toContain('Author the pull request from the branch diff.')
    expect(output.events.filter((event) => event.kind === 'phase_started').map((event) => event.phase)).toEqual([
      'push',
      'author_pull_request',
      'create_pull_request',
    ])
    expect(output.calls.find((call) => call.bin === 'gh' && call.args[1] === 'view')?.env).toBeUndefined()
    const createCall = output.calls.find((call) => call.bin === 'gh' && call.args[1] === 'create')
    expect(createCall?.env).toBeUndefined()
    expect(createCall?.args).toContain('--title')
    expect(createCall?.args).toContain('--body-file')
    expect(createCall?.args).not.toContain('--fill')
    expect(output.calls.find((call) => call.bin === 'git' && call.args[0] === 'push')?.env).toBeUndefined()
  })
})
