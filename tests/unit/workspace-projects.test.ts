import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { resetTestDatabase } from './helpers/test-db'
import { memberActor } from './helpers/actors'

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

// A member of one organization, as the handler passes `ctx.actor`.
const inOrg = (userId: string, organizationId = 'org-a', organizationRole: 'member' | 'owner' = 'member') => memberActor(userId, userId, { organizationId, organizationRole })
const ALICE = inOrg('alice')
const BOB = inOrg('bob')

describe('workspace projects', () => {
  test('one repository is one project, however it is written', async () => {
    // WHY: two members adding the same repository — one by key, one by clone
    // URL — must not give the organization two projects that split its tasks.
    const first = await projects.addWorkspaceProject('org-a', { repositoryKey: 'github.com/acme/web' }, ALICE, 'alice')
    const second = await projects.addWorkspaceProject('org-a', { repositoryKey: 'git@github.com:Acme/web.git' }, BOB, 'bob')

    expect(second.id).toBe(first.id)
    expect(first).toMatchObject({ repositoryKey: 'github.com/acme/web', displayName: 'web', createdBy: 'alice' })
    expect(await projects.listWorkspaceProjects(ALICE)).toHaveLength(1)
  })

  test("an organization never sees another organization's projects", async () => {
    await projects.addWorkspaceProject('org-a', { repositoryKey: 'github.com/acme/web' }, ALICE, 'alice')
    expect(await projects.listWorkspaceProjects(inOrg('carol', 'org-b'))).toEqual([])
  })

  test('refuses something that is not a hosted repository', async () => {
    await expect(projects.addWorkspaceProject('org-a', { repositoryKey: '/Users/alice/web' }, ALICE, 'alice')).rejects.toThrow()
  })

  test("a project's shared settings change for everyone, and only in its organization", async () => {
    // WHY: the default branch is what every member's new worktree of the project
    // starts from; one member's edit is the organization's setting.
    const project = await projects.addWorkspaceProject('org-a', { repositoryKey: 'github.com/acme/web' }, ALICE, 'alice')
    const updated = await projects.updateWorkspaceProject(ALICE, project.id, { displayName: 'Web app', defaultBranch: 'develop' })
    expect(updated).toMatchObject({ displayName: 'Web app', defaultBranch: 'develop' })
    expect((await projects.listWorkspaceProjects(ALICE))[0]).toMatchObject({ defaultBranch: 'develop' })
    await expect(projects.updateWorkspaceProject(inOrg('carol', 'org-b'), project.id, { defaultBranch: 'main' })).rejects.toThrow()
    expect((await projects.updateWorkspaceProject(ALICE, project.id, { defaultBranch: null })).defaultBranch).toBeNull()
  })

  test('a removed project leaves the directory', async () => {
    const project = await projects.addWorkspaceProject('org-a', { repositoryKey: 'github.com/acme/web' }, ALICE, 'alice')
    await projects.removeWorkspaceProject(ALICE, project.id)
    expect(await projects.listWorkspaceProjects(ALICE)).toEqual([])
  })

  test('each reader sees their own role, so only the owner and an administrator are offered rename and remove', async () => {
    // WHY: every member lists the directory (access-model.md §2.3.1), but the
    // controls follow the role the gate checks (§2.7).
    const project = await projects.addWorkspaceProject('org-a', { repositoryKey: 'github.com/acme/web' }, ALICE, 'alice')
    expect(project.role).toBe('owner')
    expect((await projects.listWorkspaceProjects(BOB))[0]?.role).toBe('none')
    expect((await projects.listWorkspaceProjects(inOrg('olivia', 'org-a', 'owner')))[0]?.role).toBe('editor')
  })
})
