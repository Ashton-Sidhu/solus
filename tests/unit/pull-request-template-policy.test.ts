import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { join } from 'path'

const root = join(import.meta.dir, '../..')

describe('pull-request template policy', () => {
  test('does not read the repository template when the setting is disabled', () => {
    const script = String.raw`
      import { mock } from 'bun:test'

      const calls = []
      mock.module('./packages/server/src/git/exec', () => ({
        runAsync: async (_bin, args) => {
          calls.push(args)
          if (args[0] === 'show') return '## Repository template'
          if (args[0] === 'rev-parse') return 'base-sha'
          return ''
        },
      }))

      const { readPullRequestAuthoringContext } = await import(
        './packages/server/src/git/pull-request-authoring'
      )
      const context = await readPullRequestAuthoringContext(
        '/tmp/repo',
        'main',
        'feature/settings',
        false,
      )
      console.log(JSON.stringify({ calls, context }))
    `
    const run = spawnSync(process.execPath, ['-e', script], {
      cwd: root,
      encoding: 'utf8',
    })

    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    // SAFETY: The child script prints this exact test-owned JSON payload.
    const output = JSON.parse(run.stdout) as {
      calls: string[][]
      context: { template: string | null }
    }
    expect(output.calls.some((args) => args[0] === 'show')).toBe(false)
    expect(output.context.template).toBeNull()
  })
})
