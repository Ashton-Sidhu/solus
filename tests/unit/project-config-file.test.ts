import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'

/**
 * Project config lives at `.solus/config.json` in the repository. These pin the
 * property the sha256 key used to provide — one config per repo, reachable from
 * any directory inside it.
 */

type ProjectConfigModule = typeof import('@solus/server/project-config/project-config')

let projectConfig: ProjectConfigModule
let repo: string

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

beforeAll(async () => {
  // Resolved because git reports the real path, and macOS serves the temp dir
  // through the /var → /private/var symlink.
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'solus-project-config-')))
  git(['init', '-q', '.'], repo)
  mkdirSync(join(repo, 'packages', 'deep'), { recursive: true })
  projectConfig = await import('@solus/server/project-config/project-config')
})

afterAll(() => {
  rmSync(repo, { recursive: true, force: true })
})

// The helpers under test start processes; with no caller, they act as the host (plans/019).
actAsHostForTests()

describe('project config in the repository', () => {
  test('a config written from a subdirectory is read from anywhere in the repo', async () => {
    // The property the hashed key provided, and the reason the file sits at the
    // repo root rather than beside the session's working directory.
    await projectConfig.saveProjectConfig(join(repo, 'packages', 'deep'), {
      version: 1,
      taskDoneOnMerge: false,
    })

    const fromRoot = await projectConfig.loadProjectConfig(repo)
    const fromElsewhere = await projectConfig.loadProjectConfig(join(repo, 'packages'))

    expect(fromRoot?.taskDoneOnMerge).toBe(false)
    expect(fromElsewhere).toEqual(fromRoot)
  })

  test('it lands where a human can find it and a diff can show it', async () => {
    const path = join(repo, '.solus', 'config.json')
    expect(existsSync(path)).toBe(true)

    const text = readFileSync(path, 'utf-8')
    // Committable: pretty-printed and newline-terminated, not a minified blob.
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toContain('"taskDoneOnMerge": false')
  })

  test('every worktree of a repo shares one config', async () => {
    // A Solus worktree is a checkout of the same project. Its config is the
    // project's, so the path is stripped back to the base repo.
    //
    // A real worktree, not a bare mkdir: managed worktrees live inside `.git`,
    // and git refuses `rev-parse` for a directory there that is not a registered
    // work tree. Faking the directory would test the not-a-repository fallback.
    writeFileSync(join(repo, 'seed.txt'), 'seed\n')
    git(['add', '-A'], repo)
    git(['-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'seed'], repo)
    const worktree = join(repo, '.git', 'solus', 'worktrees', 'feature-branch')
    git(['worktree', 'add', '-q', '--detach', worktree, 'HEAD'], repo)

    expect(projectConfig.projectConfigPath(worktree)).toBe(join(repo, '.solus', 'config.json'))
  })

  test('a directory outside a repository is its own project', async () => {
    const loose = mkdtempSync(join(tmpdir(), 'solus-no-repo-'))
    try {
      await projectConfig.saveProjectConfig(loose, { version: 1, taskDoneOnMerge: true })
      expect((await projectConfig.loadProjectConfig(loose))?.taskDoneOnMerge).toBe(true)
    } finally {
      rmSync(loose, { recursive: true, force: true })
    }
  })

  test('a file that still lists task sources reads without them', async () => {
    // Task sources are the person's own, in their personal settings
    // (docs/tasks.md). A committed file from before keeps its other settings,
    // and its sources no longer decide where a task is read or created.
    mkdirSync(join(repo, '.solus'), { recursive: true })
    writeFileSync(join(repo, '.solus', 'config.json'), JSON.stringify({
      version: 1,
      taskDoneOnMerge: false,
      taskSources: [{ kind: 'jira-board', cloudId: 'site', boardId: 12 }],
      defaultTaskSource: 'jira-board:site/12',
    }))

    expect(await projectConfig.loadProjectConfig(repo)).toEqual({ version: 1, taskDoneOnMerge: false })
  })

  test('an unconfigured project reads as null, not as defaults', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'solus-unconfigured-'))
    try {
      expect(await projectConfig.loadProjectConfig(fresh)).toBeNull()
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })

  test('a hand-edited file that is not valid JSON does not throw at the caller', async () => {
    const broken = mkdtempSync(join(tmpdir(), 'solus-broken-'))
    try {
      mkdirSync(join(broken, '.solus'), { recursive: true })
      writeFileSync(join(broken, '.solus', 'config.json'), '{ taskDoneOnMerge: yes,,, }')
      expect(await projectConfig.loadProjectConfig(broken)).toBeNull()
    } finally {
      rmSync(broken, { recursive: true, force: true })
    }
  })
})
