import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from 'bun:sqlite'
import { alsoOnLabel, recentProjectRows } from '../../src/renderer/components/layout/lib/recent-projects'

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

const SOLUS = 'github.com/solus-sh/solus'

const recents = [
  { path: '/home/dev/projects/solus', folderName: 'solus', lastOpened: '2026-07-25T10:00:00Z' },
  { path: '/home/dev/projects/solus/.solus/wt/fix', folderName: 'fix', lastOpened: '2026-07-25T09:00:00Z' },
  { path: '/home/dev/notes', folderName: 'notes', lastOpened: '2026-07-24T09:00:00Z' },
]

const identities = [
  { path: '/home/dev/projects/solus', folderName: 'solus', repoKey: SOLUS },
  { path: '/home/dev/projects/solus/.solus/wt/fix', folderName: 'fix', repoKey: SOLUS },
]

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

describe('recent project rows', () => {
  test('two checkouts of one repository take one slot, not two', () => {
    // WHY: the list is three rows long. A base checkout and its session worktree
    // eating two of them hides a project the user actually has.
    const rows = recentProjectRows({ recents, identities, otherHosts: [], limit: 3 })
    expect(rows.map((row) => row.path)).toEqual(['/home/dev/projects/solus', '/home/dev/notes'])
  })

  test('the most recent checkout is the one that keeps the slot', () => {
    const rows = recentProjectRows({
      recents: [recents[1], recents[0], recents[2]],
      identities,
      otherHosts: [],
      limit: 3,
    })
    expect(rows[0].path).toBe('/home/dev/projects/solus/.solus/wt/fix')
  })

  test('a folder with no origin is not merged with anything', () => {
    // WHY: no remote means no repo key — two unrelated plain folders must not
    // collapse into each other just because neither could name a repository.
    const rows = recentProjectRows({
      recents: [recents[2], { ...recents[2], path: '/home/dev/scratch', folderName: 'scratch' }],
      identities: [],
      otherHosts: [],
      limit: 3,
    })
    expect(rows).toHaveLength(2)
  })

  test('a row names the other hosts holding the same repository', () => {
    // WHY: the same repo checked out on two hosts used to render as two
    // identical rows with nothing to tell them apart.
    const rows = recentProjectRows({
      recents,
      identities,
      otherHosts: [
        { id: 'studio', label: 'Studio', identities: [{ path: '/srv/solus', folderName: 'solus', repoKey: SOLUS.toUpperCase() }] },
        { id: 'bench', label: 'Bench', identities: [] },
      ],
      limit: 3,
    })
    expect(rows[0].alsoOn).toEqual([{ id: 'studio', label: 'Studio' }])
    expect(rows[1].alsoOn).toEqual([])
  })

  test('more than two hosts are counted rather than listed', () => {
    // WHY: a 200px row can print two names; five is a list nobody reads.
    expect(alsoOnLabel([{ label: 'Studio' }, { label: 'Bench' }])).toBe('Also on Studio, Bench')
    expect(alsoOnLabel([{ label: 'A' }, { label: 'B' }, { label: 'C' }])).toBe('Also on 3 hosts')
  })
})
