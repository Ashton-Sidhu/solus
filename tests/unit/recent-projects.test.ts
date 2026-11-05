import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))

/**
 * Recents are the project list ordered by last use (plans/029 §3.7): there is
 * no second table of recent folders. What the directory picker shows is what
 * `projects` knows, newest use first.
 */

type DbModule = typeof import('@solus/server/db')
type RecentProjectsModule = typeof import('@solus/server/recent-projects')

let dataDir: string
let db: DbModule
let recentProjects: RecentProjectsModule
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'solus-recents-')))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  // Root resolution runs git, and every process acts as someone.
  ;(await import('@solus/server/execution/seats/acting-identity')).actAsHostForTests()
  recentProjects = await import('@solus/server/recent-projects')
})

afterEach(() => {
  // db stays undefined when beforeAll's import failed (e.g. another test file
  // already poisoned node:sqlite); let that file's real error surface alone.
  if (!db) return
  db.closeDb()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
  rmSync(join(dataDir, 'projects'), { recursive: true, force: true })
})

afterAll(() => {
  if (!db) return
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

/** Pretend the project was last used at `at`, so an order does not depend on the clock. */
function lastUsed(path: string, at: number): void {
  db.getDb().prepare('UPDATE projects SET last_used_at = ? WHERE path = ?').run(at, path)
}

describe('recent projects come from the project list', () => {
  test('a worktree is tracked as its repository root', async () => {
    // WHY: Cmd+Shift+O opens projects, so a session worktree must never appear
    // there as if it were a standalone project. The recent is the repository
    // root, as the project list shows it.
    const projectPath = join(dataDir, 'solus')
    mkdirSync(projectPath)
    await recentProjects.trackRecentProject(join(projectPath, '.git', 'solus', 'worktrees', 'fix-open-projects'))

    expect(db.getDb().prepare('SELECT path, folder_name FROM projects').all()).toEqual([
      { path: projectPath, folder_name: 'solus' },
    ])
    expect(await recentProjects.listRecentProjects()).toMatchObject([
      { path: projectPath, folderName: 'solus' },
    ])
  })

  test('the ten most recently used projects, newest first, with the time of that use', async () => {
    // WHY: the picker only has room for a concise history, with newest projects
    // visible before older ones. The order is the project's last use, which a
    // session start moves too, not a separate log of opens.
    for (let i = 0; i < 11; i++) {
      const projectPath = join(dataDir, `project-${i}`)
      mkdirSync(projectPath)
      await recentProjects.trackRecentProject(projectPath)
      lastUsed(projectPath, 1_000 + i)
    }

    const projects = await recentProjects.listRecentProjects()
    expect(projects).toHaveLength(10)
    expect(projects.map((project) => project.path)).toEqual(
      Array.from({ length: 10 }, (_, i) => join(dataDir, `project-${10 - i}`)),
    )
    expect(projects[0]!.lastOpened).toBe(new Date(1_010).toISOString())
  })

  test('tracking a project again moves it to the top', async () => {
    const older = join(dataDir, 'older')
    const newer = join(dataDir, 'newer')
    mkdirSync(older)
    mkdirSync(newer)
    await recentProjects.trackRecentProject(older)
    lastUsed(older, 1_000)
    await recentProjects.trackRecentProject(newer)
    lastUsed(newer, 2_000)
    expect((await recentProjects.listRecentProjects()).map((project) => project.path)).toEqual([newer, older])

    await recentProjects.trackRecentProject(older)

    expect((await recentProjects.listRecentProjects()).map((project) => project.path)).toEqual([older, newer])
  })

  test('a folder that is gone is left out', async () => {
    // WHY: a recent that opens nothing is a dead row in the picker.
    const kept = join(dataDir, 'kept')
    const removed = join(dataDir, 'removed')
    mkdirSync(kept)
    mkdirSync(removed)
    await recentProjects.trackRecentProject(kept)
    await recentProjects.trackRecentProject(removed)
    rmSync(removed, { recursive: true })

    expect((await recentProjects.listRecentProjects()).map((project) => project.path)).toEqual([kept])
  })

  test('a chat and an unknown working directory are never projects', async () => {
    await recentProjects.trackRecentProject('~')
    await recentProjects.trackRecentProject('')

    expect(await recentProjects.listRecentProjects()).toEqual([])
  })
})
