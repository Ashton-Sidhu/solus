import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from 'bun:sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

type DbModule = typeof import('@solus/server/db')
type ManifestModule = typeof import('@solus/server/project-config/projects-manifest')

let dataDir: string
let db: DbModule
let manifest: ManifestModule
let changes = 0
let stopListening: () => void

beforeAll(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'solus-projects-')))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  // Root resolution runs git, and every process acts as someone.
  ;(await import('@solus/server/execution/seats/acting-identity')).actAsHostForTests()
  manifest = await import('@solus/server/project-config/projects-manifest')
  stopListening = manifest.onProjectsChanged(() => { changes++ })
})

afterEach(() => {
  if (!db) return
  db.closeDb()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
  rmSync(join(dataDir, 'repos'), { recursive: true, force: true })
  changes = 0
})

afterAll(() => {
  stopListening?.()
  if (!db) return
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

/** A Git repository with one commit, so `git worktree add` works. */
function makeRepo(name: string): string {
  const repo = join(dataDir, 'repos', name)
  mkdirSync(join(repo, 'src'), { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  git('init', '-q')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
  return repo
}

function addWorktree(repo: string, name: string): string {
  const worktree = join(repo, '.git', 'solus', 'worktrees', name)
  execFileSync('git', ['worktree', 'add', '-q', '-b', name, worktree], { cwd: repo, stdio: 'ignore' })
  return worktree
}

/** Pretend the project was last used long ago, past the last-use interval. */
function ageProject(path: string, at = 1_000): void {
  db.getDb().prepare('UPDATE projects SET added_at = ?, last_used_at = ? WHERE path = ?').run(at, at, path)
}

describe('host project list (project-model §2)', () => {
  test('adding a worktree or a subfolder lists the repository root once', async () => {
    // WHY: the host list is the only record of projects; a worktree or a
    // subfolder is a checkout of the same project, never a second project.
    const repo = makeRepo('web')
    await manifest.recordProject(addWorktree(repo, 'fix'))
    await manifest.recordProject(join(repo, 'src'))
    await manifest.recordProject(repo)

    expect((await manifest.listProjects()).map((project) => project.path)).toEqual([repo])
    expect(changes).toBe(3)
  })

  test('a chat, a dispatch clone and the home placeholder are never listed', async () => {
    const dispatch = join(dataDir, 'repos', 'solus-remote', 'o', 'github.com', 'o', 'r')
    mkdirSync(dispatch, { recursive: true })
    const chat = join(dataDir, 'repos', '.solus-chats')
    mkdirSync(chat, { recursive: true })
    await manifest.recordProject(dispatch)
    await manifest.recordProject(chat)
    await manifest.recordProject('~')

    expect(await manifest.listProjects()).toEqual([])
    expect(changes).toBe(0)
  })

  test('the projects root is never a project, and an old row for it leaves the list', async () => {
    // WHY: the root holds every project and chat the host makes. Listed, it is
    // a "projects" row that scopes to nothing.
    const root = join(dataDir, 'repos', 'projects-root')
    mkdirSync(root, { recursive: true })
    process.env.SOLUS_PROJECTS_ROOT = root
    try {
      await manifest.recordProject(root)
      expect(await manifest.listProjects()).toEqual([])
      expect(changes).toBe(0)

      db.getDb().prepare('INSERT INTO projects (key, path, folder_name, added_at) VALUES (?, ?, ?, ?)').run('old-root', root, 'projects-root', 1)
      expect(await manifest.listProjects()).toEqual([])
    } finally {
      delete process.env.SOLUS_PROJECTS_ROOT
    }
  })

  test('adding a listed project again moves it to the top', async () => {
    // WHY: an explicit add is a use; lists order by last use.
    const web = makeRepo('web')
    const api = makeRepo('api')
    await manifest.recordProject(web)
    await manifest.recordProject(api)
    ageProject(web, 1_000)
    ageProject(api, 2_000)
    expect((await manifest.listProjects()).map((project) => project.path)).toEqual([api, web])

    await manifest.recordProject(web)
    const listed = await manifest.listProjects()
    expect(listed.map((project) => project.path)).toEqual([web, api])
    expect(listed[0]!.addedAt).toBe(new Date(1_000).toISOString())
    expect(Date.parse(listed[0]!.lastUsedAt)).toBeGreaterThan(2_000)
  })

  test('untracking takes the project off the list and keeps its tasks and data', async () => {
    // WHY: "Remove" is not destructive; only deleteProject removes data.
    const repo = makeRepo('web')
    await manifest.recordProject(repo)
    const [project] = await manifest.listProjects()
    const projectData = join(dataDir, 'projects', project!.key)
    mkdirSync(projectData, { recursive: true })
    db.getDb().prepare('INSERT INTO tasks (id, project_key, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('t1', project!.key, 'Keep me', 1, 1)
    db.getDb().prepare('INSERT INTO recent_projects (path, folder_name, last_opened) VALUES (?, ?, ?)').run(repo, 'web', 1)
    changes = 0

    await manifest.untrackProject(repo)

    expect(await manifest.listProjects()).toEqual([])
    expect(db.getDb().prepare('SELECT path FROM recent_projects').all()).toEqual([])
    expect(db.getDb().prepare('SELECT title FROM tasks WHERE project_key = ?').all(project!.key)).toEqual([{ title: 'Keep me' }])
    expect(existsSync(projectData)).toBe(true)
    expect(changes).toBe(1)

    await manifest.recordProject(repo)
    expect((await manifest.listProjects()).map((listed) => listed.key)).toEqual([project!.key])
    rmSync(projectData, { recursive: true, force: true })
  })

  test('a session in a listed project, its worktree or subfolder moves its last use', async () => {
    const web = makeRepo('web')
    const api = makeRepo('api')
    await manifest.recordProject(web)
    await manifest.recordProject(api)
    ageProject(web, 1_000)
    ageProject(api, 2_000)
    changes = 0

    manifest.recordProjectUse(addWorktree(web, 'fix'))
    expect((await manifest.listProjects()).map((project) => project.path)).toEqual([web, api])
    expect(changes).toBe(1)

    ageProject(web, 1_000)
    manifest.recordProjectUse(join(web, 'src'))
    expect((await manifest.listProjects())[0]!.path).toBe(web)
    expect(changes).toBe(2)
  })

  test('a session moves last use at most once a minute, so turns do not flood clients', async () => {
    const repo = makeRepo('web')
    await manifest.recordProject(repo)
    changes = 0
    manifest.recordProjectUse(repo)
    expect(changes).toBe(0)
  })

  test('a session in an unlisted folder adds nothing', async () => {
    // WHY: a session does not add its folder; only an explicit add does.
    const repo = makeRepo('scratch')
    manifest.recordProjectUse(repo)
    manifest.recordProjectUse(join(repo, 'src'))
    expect(await manifest.listProjects()).toEqual([])
    expect(changes).toBe(0)
  })
})
