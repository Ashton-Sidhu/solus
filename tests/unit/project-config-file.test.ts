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
      taskSources: [{ kind: 'jira-project', cloudId: 'acme', projectKey: 'SOL' }],
    })

    const fromRoot = await projectConfig.loadProjectConfig(repo)
    const fromElsewhere = await projectConfig.loadProjectConfig(join(repo, 'packages'))

    expect(fromRoot?.taskSources).toEqual([{ kind: 'jira-project', cloudId: 'acme', projectKey: 'SOL' }])
    expect(fromElsewhere).toEqual(fromRoot)
  })

  test('it lands where a human can find it and a diff can show it', async () => {
    const path = join(repo, '.solus', 'config.json')
    expect(existsSync(path)).toBe(true)

    const text = readFileSync(path, 'utf-8')
    // Committable: pretty-printed and newline-terminated, not a minified blob.
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toContain('"kind": "jira-project"')
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

  test('a project lists many task sources, and each one time', async () => {
    // A project reads tasks from any number of boards. The same board twice
    // would show each of its tasks twice.
    const saved = await projectConfig.saveProjectConfig(repo, {
      version: 1,
      taskSources: [
        { kind: 'github-repo', owner: 'Acme', repo: 'App' },
        { kind: 'github-project', owner: 'acme', number: 4 },
        { kind: 'jira-board', cloudId: 'site', boardId: 12 },
        { kind: 'github-project', owner: 'ACME', number: 4 },
      ],
    })

    expect(saved.taskSources?.map((source) => source.kind)).toEqual(['github-repo', 'github-project', 'jira-board'])
    expect(await projectConfig.loadProjectConfig(repo)).toEqual(saved)
  })

  test('a project with task sources always has a default source that it lists', async () => {
    // A new task is created in the default source. A default that names a
    // removed source would send the task to a board the project does not show.
    const sources = [
      { kind: 'github-repo', owner: 'acme', repo: 'app' },
      { kind: 'jira-project', cloudId: 'site', projectKey: 'SOL' },
    ] as const

    const unset = await projectConfig.saveProjectConfig(repo, { version: 1, taskSources: [...sources] })
    expect(unset.defaultTaskSource).toBe('github-repo:acme/app')

    const chosen = await projectConfig.saveProjectConfig(repo, {
      version: 1, taskSources: [...sources], defaultTaskSource: 'jira-project:site/SOL',
    })
    expect(chosen.defaultTaskSource).toBe('jira-project:site/SOL')

    const removed = await projectConfig.saveProjectConfig(repo, {
      version: 1, taskSources: [sources[0]], defaultTaskSource: 'jira-project:site/SOL',
    })
    expect(removed.defaultTaskSource).toBe('github-repo:acme/app')

    const none = await projectConfig.saveProjectConfig(repo, { version: 1, defaultTaskSource: 'github-repo:acme/app' })
    expect(none.defaultTaskSource).toBeUndefined()
  })

  test('one malformed task source in a hand-edited file does not remove the others', async () => {
    writeFileSync(join(repo, '.solus', 'config.json'), JSON.stringify({
      taskSources: [{ kind: 'trello', board: 'x' }, { kind: 'jira-board', cloudId: 'site', boardId: 12 }],
    }))

    const config = await projectConfig.loadProjectConfig(repo)
    expect(config?.taskSources).toEqual([{ kind: 'jira-board', cloudId: 'site', boardId: 12 }])
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
      writeFileSync(join(broken, '.solus', 'config.json'), '{ taskSources: jira,,, }')
      expect(await projectConfig.loadProjectConfig(broken)).toBeNull()
    } finally {
      rmSync(broken, { recursive: true, force: true })
    }
  })
})
