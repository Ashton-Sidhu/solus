import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

/**
 * Project config lives at `.solus/config.json` in the repository. These pin the
 * property the sha256 key used to provide — one config per repo, reachable from
 * any directory inside it — plus the migration off the database row.
 */

type ProjectConfigModule = typeof import('@solus/server/project-config/project-config')

const db = new Database(':memory:')
db.run('CREATE TABLE project_config (project_key TEXT PRIMARY KEY, config TEXT, updated_at INTEGER)')
mock.module('@solus/server/db', () => ({ getDb: () => db, withTx: (fn: () => void) => fn() }))

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

describe('project config in the repository', () => {
  test('a config written from a subdirectory is read from anywhere in the repo', async () => {
    // The property the hashed key provided, and the reason the file sits at the
    // repo root rather than beside the session's working directory.
    await projectConfig.saveProjectConfig(join(repo, 'packages', 'deep'), {
      version: 1,
      taskProvider: 'jira',
      taskProviderConfig: { cloudId: 'acme', projectKey: 'SOL' },
    })

    const fromRoot = await projectConfig.loadProjectConfig(repo)
    const fromElsewhere = await projectConfig.loadProjectConfig(join(repo, 'packages'))

    expect(fromRoot?.taskProvider).toBe('jira')
    expect(fromRoot?.taskProviderConfig?.projectKey).toBe('SOL')
    expect(fromElsewhere).toEqual(fromRoot)
  })

  test('it lands where a human can find it and a diff can show it', async () => {
    const path = join(repo, '.solus', 'config.json')
    expect(existsSync(path)).toBe(true)

    const text = readFileSync(path, 'utf-8')
    // Committable: pretty-printed and newline-terminated, not a minified blob.
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toContain('"taskProvider": "jira"')
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
      writeFileSync(join(broken, '.solus', 'config.json'), '{ taskProvider: jira,,, }')
      expect(await projectConfig.loadProjectConfig(broken)).toBeNull()
    } finally {
      rmSync(broken, { recursive: true, force: true })
    }
  })
})

describe('migration off the database row', () => {
  test('a project configured before the move keeps its provider', async () => {
    // Losing this silently would point a project's task sync at the wrong
    // provider — or at none — with nothing to tell the user why.
    const legacy = mkdtempSync(join(tmpdir(), 'solus-legacy-'))
    try {
      db.prepare('INSERT INTO project_config (project_key, config, updated_at) VALUES (?, ?, ?)').run(
        createHash('sha256').update(legacy).digest('hex'),
        JSON.stringify({ version: 1, taskProvider: 'github', tasksAutoPushComments: true }),
        Date.now(),
      )

      const migrated = await projectConfig.loadProjectConfig(legacy)

      expect(migrated?.taskProvider).toBe('github')
      expect(migrated?.tasksAutoPushComments).toBe(true)
      // Written through, so the next read comes from the file.
      expect(existsSync(join(legacy, '.solus', 'config.json'))).toBe(true)
    } finally {
      rmSync(legacy, { recursive: true, force: true })
    }
  })

  test('the file wins once it exists, so an edit is not undone by the old row', async () => {
    const both = mkdtempSync(join(tmpdir(), 'solus-both-'))
    try {
      db.prepare('INSERT INTO project_config (project_key, config, updated_at) VALUES (?, ?, ?)').run(
        createHash('sha256').update(both).digest('hex'),
        JSON.stringify({ version: 1, taskProvider: 'github' }),
        Date.now(),
      )
      await projectConfig.saveProjectConfig(both, { version: 1, taskProvider: 'jira' })

      expect((await projectConfig.loadProjectConfig(both))?.taskProvider).toBe('jira')
    } finally {
      rmSync(both, { recursive: true, force: true })
    }
  })
})
