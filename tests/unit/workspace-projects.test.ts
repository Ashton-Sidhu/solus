import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// docs/plans/project-model.md §2: the organization's projects are repositories.
// A member adds one explicitly; every checkout of it, on any host, is that one
// project.

type ProjectsModule = typeof import('@solus/server/projects/workspace-projects')
type DbModule = typeof import('@solus/server/db')

let dataDir: string
let projects: ProjectsModule
let db: DbModule
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-workspace-projects-'))
  process.env.SOLUS_DATA_DIR = dataDir
  projects = await import('@solus/server/projects/workspace-projects')
  db = await import('@solus/server/db')
})

afterEach(async () => {
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe('workspace projects', () => {
  test('one repository is one project, however it is written', async () => {
    // WHY: two members adding the same repository — one by key, one by clone
    // URL — must not give the organization two projects that split its tasks.
    const first = await projects.addWorkspaceProject('org-a', { repositoryKey: 'github.com/acme/web' }, 'alice')
    const second = await projects.addWorkspaceProject('org-a', { repositoryKey: 'git@github.com:Acme/web.git' }, 'bob')

    expect(second.id).toBe(first.id)
    expect(first).toMatchObject({ repositoryKey: 'github.com/acme/web', displayName: 'acme/web', createdBy: 'alice' })
    expect(await projects.listWorkspaceProjects('org-a')).toHaveLength(1)
  })

  test("an organization never sees another organization's projects", async () => {
    await projects.addWorkspaceProject('org-a', { repositoryKey: 'github.com/acme/web' }, 'alice')
    expect(await projects.listWorkspaceProjects('org-b')).toEqual([])
  })

  test('refuses something that is not a hosted repository', async () => {
    await expect(projects.addWorkspaceProject('org-a', { repositoryKey: '/Users/alice/web' }, 'alice')).rejects.toThrow()
  })

  test("a project's shared settings change for everyone, and only in its organization", async () => {
    // WHY: the default branch is what every member's new worktree of the project
    // starts from; one member's edit is the organization's setting.
    const project = await projects.addWorkspaceProject('org-a', { repositoryKey: 'github.com/acme/web' }, 'alice')
    const updated = await projects.updateWorkspaceProject('org-a', project.id, { displayName: 'Web app', defaultBranch: 'develop' })
    expect(updated).toMatchObject({ displayName: 'Web app', defaultBranch: 'develop' })
    expect((await projects.listWorkspaceProjects('org-a'))[0]).toMatchObject({ defaultBranch: 'develop' })
    await expect(projects.updateWorkspaceProject('org-b', project.id, { defaultBranch: 'main' })).rejects.toThrow()
    expect((await projects.updateWorkspaceProject('org-a', project.id, { defaultBranch: null })).defaultBranch).toBeNull()
  })

  test('a removed project leaves the directory', async () => {
    const project = await projects.addWorkspaceProject('org-a', { repositoryKey: 'github.com/acme/web' }, 'alice')
    await projects.removeWorkspaceProject('org-a', project.id)
    expect(await projects.listWorkspaceProjects('org-a')).toEqual([])
  })
})
