import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { join } from 'path'

const root = join(import.meta.dir, '../..')

/**
 * `runAsync` is mocked per-subprocess (Bun's `mock.module` leaks across
 * tests in the same process) — see tests/unit/git-action-manager.test.ts for
 * the same pattern.
 */
function run(script: string): { calls: Array<{ bin: string; args: string[] }>; result: unknown } {
  const wrapped = `
    import { mock } from 'bun:test'
    const calls = []
    ${script}
  `
  const proc = spawnSync(process.execPath, ['-e', wrapped], { cwd: root, encoding: 'utf8' })
  // `resolveRepoRoot` logs a warning to stderr for the ordinary "not a
  // repository" case, so stderr is not asserted empty — only that the
  // subprocess completed and printed its result.
  expect(proc.status).toBe(0)
  return JSON.parse(proc.stdout)
}

describe('computeGitRepositoryStatus', () => {
  test('reports no repository for a plain folder', () => {
    const output = run(`
      mock.module('./packages/server/src/git/exec', () => ({
        // Loaded transitively via git-helpers -> worktree-manager, which
        // needs a same-named export even though these tests never call it.
        git: () => '',
        runAsync: async (bin, args) => {
          calls.push({ bin, args })
          if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) throw new Error('not a git repository')
          return ''
        },
      }))
      const { computeGitRepositoryStatus } = await import('./packages/server/src/git/git-init')
      const result = await computeGitRepositoryStatus('/tmp/plain-folder')
      console.log(JSON.stringify({ calls, result }))
    `)
    expect(output.result).toEqual({
      isRepository: false,
      hasCommits: false,
      branch: null,
      primaryRemoteName: null,
      primaryRemoteUrl: null,
    })
  })

  test('reports commits, branch and the primary remote for an ordinary repository', () => {
    const output = run(`
      mock.module('./packages/server/src/git/exec', () => ({
        // Loaded transitively via git-helpers -> worktree-manager, which
        // needs a same-named export even though these tests never call it.
        git: () => '',
        runAsync: async (bin, args) => {
          calls.push({ bin, args })
          if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return '/repo/.git'
          if (args[0] === 'rev-parse' && args.includes('HEAD') && args.includes('--verify')) return 'abc123'
          if (args[0] === 'symbolic-ref') return 'main'
          if (args[0] === 'remote') return 'https://github.com/acme/widgets.git'
          return ''
        },
      }))
      const { computeGitRepositoryStatus } = await import('./packages/server/src/git/git-init')
      const result = await computeGitRepositoryStatus('/repo')
      console.log(JSON.stringify({ calls, result }))
    `)
    expect(output.result).toEqual({
      isRepository: true,
      hasCommits: true,
      branch: 'main',
      primaryRemoteName: 'origin',
      primaryRemoteUrl: 'https://github.com/acme/widgets.git',
    })
  })

  test('reports an unborn HEAD and no remote for a freshly initialized repository', () => {
    // WHY: `GitState`/`GitIdentity` both go null for this exact case — the
    // empty state this RPC exists to distinguish from "no repository at all".
    const output = run(`
      mock.module('./packages/server/src/git/exec', () => ({
        // Loaded transitively via git-helpers -> worktree-manager, which
        // needs a same-named export even though these tests never call it.
        git: () => '',
        runAsync: async (bin, args) => {
          calls.push({ bin, args })
          if (args[0] === 'rev-parse' && args.includes('--git-common-dir')) return '/repo/.git'
          if (args[0] === 'rev-parse' && args.includes('HEAD') && args.includes('--verify')) throw new Error('unborn branch')
          if (args[0] === 'symbolic-ref') return 'main'
          if (args[0] === 'remote') throw new Error('No such remote')
          return ''
        },
      }))
      const { computeGitRepositoryStatus } = await import('./packages/server/src/git/git-init')
      const result = await computeGitRepositoryStatus('/repo')
      console.log(JSON.stringify({ calls, result }))
    `)
    expect(output.result).toEqual({
      isRepository: true,
      hasCommits: false,
      branch: 'main',
      primaryRemoteName: null,
      primaryRemoteUrl: null,
    })
  })
})

describe('initRepository', () => {
  test('initializes on main when no default branch is configured', () => {
    const output = run(`
      mock.module('./packages/server/src/git/exec', () => ({
        // Loaded transitively via git-helpers -> worktree-manager, which
        // needs a same-named export even though these tests never call it.
        git: () => '',
        runAsync: async (bin, args) => {
          calls.push({ bin, args })
          if (args.includes('init.defaultBranch')) return ''
          return ''
        },
      }))
      const { initRepository } = await import('./packages/server/src/git/git-init')
      const result = await initRepository('/repo')
      console.log(JSON.stringify({ calls, result }))
    `)
    expect(output.result).toEqual({ defaultBranch: 'main' })
    expect(output.calls.find((c) => c.args[0] === 'init')?.args).toEqual(['init', '-b', 'main'])
    // WHY: Initialize Git must never create a commit.
    expect(output.calls.some((c) => c.args[0] === 'commit')).toBe(false)
  })

  test('uses a valid configured default branch instead of main', () => {
    const output = run(`
      mock.module('./packages/server/src/git/exec', () => ({
        // Loaded transitively via git-helpers -> worktree-manager, which
        // needs a same-named export even though these tests never call it.
        git: () => '',
        runAsync: async (bin, args) => {
          calls.push({ bin, args })
          if (args.includes('init.defaultBranch')) return 'trunk'
          if (args[0] === 'check-ref-format') return ''
          return ''
        },
      }))
      const { initRepository } = await import('./packages/server/src/git/git-init')
      const result = await initRepository('/repo')
      console.log(JSON.stringify({ calls, result }))
    `)
    expect(output.result).toEqual({ defaultBranch: 'trunk' })
    expect(output.calls.find((c) => c.args[0] === 'init')?.args).toEqual(['init', '-b', 'trunk'])
  })

  test('falls back to main when the configured default branch is invalid', () => {
    const output = run(`
      mock.module('./packages/server/src/git/exec', () => ({
        // Loaded transitively via git-helpers -> worktree-manager, which
        // needs a same-named export even though these tests never call it.
        git: () => '',
        runAsync: async (bin, args) => {
          calls.push({ bin, args })
          if (args.includes('init.defaultBranch')) return 'not a ref'
          if (args[0] === 'check-ref-format') throw new Error('invalid refname')
          return ''
        },
      }))
      const { initRepository } = await import('./packages/server/src/git/git-init')
      const result = await initRepository('/repo')
      console.log(JSON.stringify({ calls, result }))
    `)
    expect(output.result).toEqual({ defaultBranch: 'main' })
  })
})
