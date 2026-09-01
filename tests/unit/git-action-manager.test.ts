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
    // `pullRequest` is null because this run supplies no `readPullRequest`:
    // the step reports what the action itself produced, and says plainly that
    // nobody read the pull request back rather than assembling a stand-in.
    expect(output.result.pullRequest).toEqual({
      status: 'existing',
      url: 'https://github.com/solus-sh/solus/pull/51',
      number: 51,
      title: 'Publish Git actions',
      pullRequest: null,
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
        runAsync: async (bin, args, _cwd, options = {}) => {
          calls.push({ bin, args, env: options.env })
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

    expect(run.stderr).toContain('provider_adapter_failed')
    expect(run.status).toBe(0)
    // SAFETY: The child script serializes this exact result shape above.
    expect(run.stdout).toContain('provider_cli_fallback_succeeded')
    const output = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as {
      calls: Array<{ bin: string; args: string[]; env?: NodeJS.ProcessEnv }>
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
    const createCall = output.calls.find((call) => call.bin === 'gh' && call.args[1] === 'create')
    expect(createCall?.env).toBeUndefined()
    // The CLI fallback ran because the API credential failed, so there is no
    // provider to read the pull request back from. Null is the honest answer;
    // the client asks by number.
    expect(output.result.pullRequest).toEqual({
      status: 'created',
      url: 'https://github.com/solus-sh/solus/pull/72',
      number: 72,
      title: 'fix(git): fall back to GitHub CLI',
      pullRequest: null,
    })
  })

  test('the step carries the pull request the provider returned, not one assembled from the step', () => {
    const script = String.raw`
      import { mock } from 'bun:test'

      mock.module('./packages/server/src/git/exec', () => ({
        runAsync: async (bin, args) => {
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

      const readNumbers = []
      const { runGitAction } = await import('./packages/server/src/git/git-action-manager')
      const result = await runGitAction(
        { actionId: 'action-read-back', action: 'commit_push_pull_request' },
        { branch: 'feature/x', targetBranch: 'main' },
        '/tmp/solus-read-back',
        {
          generateCommitSubject: async () => 'feat(git): publish Git actions',
          publish: () => {},
          writer: {
            provider: 'codex',
            textGenerator: { generate: async () => '' },
            instructions: 'Follow repository conventions.',
            followPullRequestTemplate: true,
          },
          readPullRequest: async (number) => {
            readNumbers.push(number)
            return { number, title: 'What the provider says', headRef: 'feature/x' }
          },
        },
      )
      console.log(JSON.stringify({ readNumbers, result }))
    `
    const run = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' })

    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    // SAFETY: The child script serializes this exact result shape above.
    const output = JSON.parse(run.stdout) as {
      readNumbers: number[]
      result: { pullRequest: { title: string; pullRequest: { title: string } | null } }
    }
    // The step's own `title` is what the create/lookup produced; `pullRequest`
    // is the provider's record of the same pull request. A client indexes the
    // second, so it never has to invent capabilities or a head revision.
    expect(output.readNumbers).toEqual([51])
    expect(output.result.pullRequest.title).toBe('Publish Git actions')
    expect(output.result.pullRequest.pullRequest?.title).toBe('What the provider says')
  })

  test('a read-back failure leaves the step intact rather than failing the action', () => {
    const script = String.raw`
      import { mock } from 'bun:test'

      mock.module('./packages/server/src/git/exec', () => ({
        runAsync: async (bin, args) => {
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
        { actionId: 'action-read-fails', action: 'commit_push_pull_request' },
        { branch: 'feature/x', targetBranch: 'main' },
        '/tmp/solus-read-fails',
        {
          generateCommitSubject: async () => 'feat(git): publish Git actions',
          publish: () => {},
          writer: {
            provider: 'codex',
            textGenerator: { generate: async () => '' },
            instructions: 'Follow repository conventions.',
            followPullRequestTemplate: true,
          },
          readPullRequest: async () => { throw new Error('no credential for this checkout') },
        },
      )
      console.log(JSON.stringify({ result }))
    `
    const run = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' })

    expect(run.status).toBe(0)
    // SAFETY: The child script serializes this exact result shape above.
    const output = JSON.parse(run.stdout) as {
      result: { pullRequest: { number: number; pullRequest: unknown } }
    }
    // The pull request exists whether or not Solus could read it back, so the
    // action reports success and the client asks by number.
    expect(output.result.pullRequest.number).toBe(51)
    expect(output.result.pullRequest.pullRequest).toBeNull()
  })
})
