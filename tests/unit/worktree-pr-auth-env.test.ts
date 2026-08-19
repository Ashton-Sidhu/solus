import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { join } from 'path'

const root = join(import.meta.dir, '../..')

describe('Git action GitHub authentication', () => {
  // A dispatch checkout's git config already pushes as the paired device, so
  // `gh` must open the pull request as that device too — otherwise one branch
  // carries the client's commits under a PR authored by the host owner.
  test('passes the checkout’s token to GitHub CLI calls only, and authors the PR explicitly', () => {
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
      // Which token this is comes from the checkout — see github-credentials.test.ts.
      const token = 'delegated-token'
      const result = await runGitAction(
        { actionId: 'action-1', action: 'create_pull_request' },
        { branch: 'solus/dispatched-fix', targetBranch: 'main' },
        dispatchCheckout,
        {
          githubToken: token,
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
      console.log(JSON.stringify({ calls, events, result, submittedBody, token }))
    `
    const run = spawnSync(process.execPath, ['-e', script], {
      cwd: root,
      encoding: 'utf8',
    })

    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    const output = JSON.parse(run.stdout) as {
      calls: Array<{ bin: string; args: string[]; env?: NodeJS.ProcessEnv }>
      events: Array<{ kind: string; phase?: string }>
      result: { pullRequest: { status: string; url: string; title: string } }
      submittedBody: string
      token: string
    }
    expect(output.token).toBe('delegated-token')
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
    expect(output.calls.find((call) => call.bin === 'gh' && call.args[1] === 'view')?.env).toEqual({
      GH_TOKEN: 'delegated-token',
    })
    const createCall = output.calls.find((call) => call.bin === 'gh' && call.args[1] === 'create')
    expect(createCall?.env).toEqual({ GH_TOKEN: 'delegated-token' })
    expect(createCall?.args).toContain('--title')
    expect(createCall?.args).toContain('--body-file')
    expect(createCall?.args).not.toContain('--fill')
    expect(output.calls.find((call) => call.bin === 'git' && call.args[0] === 'push')?.env).toBeUndefined()
  })
})
