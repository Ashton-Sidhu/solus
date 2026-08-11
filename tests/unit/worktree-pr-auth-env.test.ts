import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { join } from 'path'

const root = join(import.meta.dir, '../..')

describe('createPR GitHub authentication', () => {
  test('uses the dispatching device token as GH_TOKEN', () => {
    // Run module mocks in a child process so they cannot replace git execution
    // for unrelated unit tests in Bun's shared test process.
    const script = String.raw`
      import { mock } from 'bun:test'
      import { Database } from 'bun:sqlite'

      const calls = []
      mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
      mock.module('./src/main/git/exec', () => ({
        git: () => '',
        runAsync: async (bin, args, _cwd, options = {}) => {
          calls.push({ bin, args, env: options.env })
          if (bin === 'gh' && args[1] === 'view') throw new Error('No pull request exists')
          if (bin === 'gh' && args[1] === 'create') return 'https://github.com/solus-sh/solus/pull/42'
          return ''
        },
      }))
      mock.module('./src/main/providers/github/git-credential', () => ({
        loadGitHubAccessToken: (deviceId) => deviceId ? 'delegated-token' : 'host-token',
      }))

      const { githubTokenForWorktreeRequest } = await import('./src/main/server/handlers/worktree-handlers')
      const { createPR } = await import('./src/main/git/worktree-manager')
      const token = githubTokenForWorktreeRequest({
        clientId: 'ws:remote',
        deviceId: 'dispatching-device',
        deviceLabel: 'Sidhu’s MacBook',
      })
      const result = await createPR(
        { branch: 'solus/dispatched-fix', targetBranch: 'main' },
        '/tmp/solus-dispatched-fix',
        { githubToken: token },
      )
      console.log(JSON.stringify({ calls, result, token }))
    `
    const run = spawnSync(process.execPath, ['-e', script], {
      cwd: root,
      encoding: 'utf8',
    })

    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    const output = JSON.parse(run.stdout) as {
      calls: Array<{ bin: string; args: string[]; env?: NodeJS.ProcessEnv }>
      result: { success: boolean; url?: string }
      token: string
    }
    expect(output.token).toBe('delegated-token')
    expect(output.result).toEqual({
      success: true,
      url: 'https://github.com/solus-sh/solus/pull/42',
    })
    expect(output.calls.find((call) => call.bin === 'gh' && call.args[1] === 'view')?.env).toEqual({
      GH_TOKEN: 'delegated-token',
    })
    expect(output.calls.find((call) => call.bin === 'gh' && call.args[1] === 'create')?.env).toEqual({
      GH_TOKEN: 'delegated-token',
    })
    expect(output.calls.find((call) => call.bin === 'git' && call.args[0] === 'push')?.env).toBeUndefined()
  })
})
