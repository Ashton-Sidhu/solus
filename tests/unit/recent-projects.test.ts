import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
mock.module('../../src/main/project-config/projects-manifest', () => ({ recordProject: async () => {} }))

type DbModule = typeof import('../../src/main/db')
type RecentProjectsModule = typeof import('../../src/main/recent-projects')

let dataDir: string
let db: DbModule
let recentProjects: RecentProjectsModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-recents-'))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('../../src/main/db')
  recentProjects = await import('../../src/main/recent-projects')
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
})

describe('recent project persistence', () => {
  test('a worktree is stored as its actual project root', async () => {
    // WHY: Cmd+Shift+O opens projects, so a session worktree must never appear
    // there as if it were a standalone project.
    const projectPath = join(dataDir, 'solus')
    mkdirSync(projectPath)
    await recentProjects.trackRecentProject(join(projectPath, '.solus-worktrees', 'fix-open-projects'))

    expect(db.getDb().prepare('SELECT path, folder_name FROM recent_projects').all()).toEqual([
      { path: projectPath, folder_name: 'solus' },
    ])
    db.getDb().prepare('UPDATE recent_projects SET folder_name = ? WHERE path = ?').run('stored label', projectPath)
    expect(await recentProjects.listRecentProjects()).toMatchObject([
      { path: projectPath, folderName: 'stored label' },
    ])
  })

  test('the most recently tracked projects are capped and ordered first', async () => {
    // WHY: the picker only has room for a concise history, with newest projects
    // visible before older ones.
    for (let i = 0; i < 11; i++) {
      const projectPath = join(dataDir, `project-${i}`)
      mkdirSync(projectPath)
      await recentProjects.trackRecentProject(projectPath)
    }

    const projects = await recentProjects.listRecentProjects()
    expect(projects).toHaveLength(10)
    expect(projects.map((project) => project.path)).toEqual(
      Array.from({ length: 10 }, (_, i) => join(dataDir, `project-${10 - i}`)),
    )
  })
})
