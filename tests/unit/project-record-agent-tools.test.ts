import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'
import { installTestIdentities } from './helpers/acting-identities'
import type { Codebase } from '@solus/contracts/codebases'
import { encodePathAsFolder } from '@solus/contracts/types'
import type { Principal } from '@solus/server/admission/principal'
import type { AgentTool, AgentToolContext, AgentToolResult } from '@solus/server/execution/agents/tools/agent-tool'

mock.module('node:sqlite', () => ({ DatabaseSync }))

/**
 * The project and codebase tools act as the person of the turn, through the
 * RPCs that person's client sends: they show what that person sees, change
 * only what the call names, and never delete a folder on disk.
 */

const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'solus-project-records-')))
const projectsRoot = join(dataDir, 'projects')
const previousDataDir = process.env.SOLUS_DATA_DIR
const previousProjectsRoot = process.env.SOLUS_PROJECTS_ROOT
process.env.SOLUS_DATA_DIR = dataDir
process.env.SOLUS_PROJECTS_ROOT = projectsRoot

const OWNER: Principal = { kind: 'owner', via: 'local', expiresAt: null, deviceId: null, deviceLabel: 'Mac' }
const MEMBER: Principal = {
  kind: 'org-member', userId: 'user_records', organizationId: 'org-1', organizationRole: 'member',
  teamIds: [], hostKind: 'cloud', displayName: 'Member', deviceId: 'test', deviceLabel: 'Test', expiresAt: Date.now() + 60_000,
}
const GUEST: Principal = {
  kind: 'guest', guestId: 'guest-1', displayName: 'Guest', deviceId: 'guest-1', deviceLabel: 'Test', expiresAt: Date.now() + 60_000,
  share: { resource: { kind: 'session', id: 'caller' }, role: 'editor', sharedByUserId: 'local', linkSecretHash: 'test' },
}

let tools: typeof import('@solus/server/execution/agents/tools/project-record-tools')
let codebaseTools: typeof import('@solus/server/execution/agents/tools/codebase-tools')
let manifest: typeof import('@solus/server/project-config/projects-manifest')
let codebases: typeof import('@solus/server/data/codebases/codebases')
let records: typeof import('@solus/server/data/sessions/session-records')
let withWorkspaceToolAuthority: typeof import('@solus/server/admission/workspace-tool-authority')['withWorkspaceToolAuthority']
let setProjectToolHost: typeof import('@solus/server/execution/agents/tools/project-tools')['setProjectToolHost']
let installationId = ''
let closeDb: () => void

beforeAll(async () => {
  ;(await import('@solus/server/execution/seats/acting-identity')).actAsHostForTests()
  installTestIdentities()
  tools = await import('@solus/server/execution/agents/tools/project-record-tools')
  codebaseTools = await import('@solus/server/execution/agents/tools/codebase-tools')
  manifest = await import('@solus/server/project-config/projects-manifest')
  codebases = await import('@solus/server/data/codebases/codebases')
  records = await import('@solus/server/data/sessions/session-records')
  ;({ withWorkspaceToolAuthority } = await import('@solus/server/admission/workspace-tool-authority'))
  ;({ setProjectToolHost } = await import('@solus/server/execution/agents/tools/project-tools'))
  ;({ closeDb } = await import('@solus/server/db'))
  installationId = (await import('@solus/server/admission/auth')).getInstallationId()

  // The handlers a person's client reaches, behind the same access gate.
  const { SolusServer } = await import('@solus/server/transport/server')
  const { registerProjectConfigHandlers } = await import('@solus/server/transport/handlers/project-config-handlers')
  const { registerCodebaseHandlers } = await import('@solus/server/transport/handlers/codebase-handlers')
  const server = new SolusServer()
  registerProjectConfigHandlers(server)
  // The session folder RPCs are not used by these tools.
  registerCodebaseHandlers(server, {} as never, {} as never)
  setProjectToolHost({ rpc: {
    listProjects: (args, caller) => server.handle('listProjects', args, caller),
    projectConfigLoad: (args, caller) => server.handle('projectConfigLoad', args, caller),
    projectConfigSave: (args, caller) => server.handle('projectConfigSave', args, caller),
    untrackProject: (args, caller) => server.handle('untrackProject', args, caller),
    codebaseList: (args, caller) => server.handle('codebaseList', args, caller),
    codebaseSave: (args, caller) => server.handle('codebaseSave', args, caller),
    codebaseMembers: (args, caller) => server.handle('codebaseMembers', args, caller),
    codebaseScanFolder: (args, caller) => server.handle('codebaseScanFolder', args, caller),
  } } as never)

  // The delete reads the person's sessions through the same operations as the API.
  const { createWorkspaceOperations } = await import('@solus/server/data/workspace/service')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  const { getDatabase } = await import('@solus/server/db/database')
  const { installWorkspaceToolOperations } = await import('@solus/server/data/workspace/tool-context')
  installWorkspaceToolOperations(createWorkspaceOperations(new ShareManager({ db: getDatabase() })), 'this-mac')
})

afterEach(async () => {
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
  rmSync(projectsRoot, { recursive: true, force: true })
})

afterAll(() => {
  setProjectToolHost(null)
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  if (previousProjectsRoot === undefined) delete process.env.SOLUS_PROJECTS_ROOT
  else process.env.SOLUS_PROJECTS_ROOT = previousProjectsRoot
})

function makeRepository(path: string): string {
  mkdirSync(path, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: path, stdio: 'ignore' })
  return path
}

const context: AgentToolContext = {
  provider: 'codex', cwd: dataDir, sessionId: () => 'caller', abortSignal: new AbortController().signal,
  parentToolUseId: () => undefined, emit: () => {},
}

function run<T extends AgentTool>(tool: T, input: Parameters<T['execute']>[0], principal: Principal = OWNER): Promise<AgentToolResult> {
  return withWorkspaceToolAuthority(principal, () => tool.execute(input, context))
}

async function answer<T>(result: Promise<AgentToolResult>): Promise<T> {
  const done = await result
  expect(done).toMatchObject({ ok: true })
  return JSON.parse(done.text) as T
}

interface ProjectRow { path: string; name: string }

describe('project tools', () => {
  let web: string
  let api: string
  let mine: string

  beforeEach(async () => {
    web = makeRepository(join(projectsRoot, 'web'))
    api = makeRepository(join(projectsRoot, 'api'))
    mine = makeRepository(join(projectsRoot, 'user_records', 'mine'))
    for (const path of [web, api, mine]) await manifest.recordProject(path)
  })

  test('list_projects shows each person what their client shows', async () => {
    const owner = await answer<{ projects: ProjectRow[] }>(run(tools.listProjectsAgentTool, {}))
    expect(owner.projects.map((project) => project.path).sort()).toEqual([api, mine, web].sort())
    // WHY: a member sees only the projects in their own folder, as their project chip does.
    const member = await answer<{ projects: ProjectRow[] }>(run(tools.listProjectsAgentTool, {}, MEMBER))
    expect(member.projects.map((project) => project.path)).toEqual([mine])
  })

  test('list_projects leaves out the container root of a codebase: it is a codebase, not a project', async () => {
    const container = join(projectsRoot, 'shop')
    makeRepository(join(container, 'a'))
    makeRepository(join(container, 'b'))
    await manifest.recordProject(container)
    expect((await manifest.listProjects()).map((project) => project.path)).toContain(container)
    await codebases.saveCodebase('local', 'host', {
      id: 'shop', name: 'shop', roots: [{ installationId, path: container, name: 'shop', container: true }], updatedAt: 1, deletedAt: null,
    })
    const listed = await answer<{ projects: ProjectRow[] }>(run(tools.listProjectsAgentTool, {}))
    expect(listed.projects.map((project) => project.path)).not.toContain(container)
  })

  test('list_projects pages with nextCursor', async () => {
    const first = await answer<{ projects: ProjectRow[]; nextCursor?: string }>(run(tools.listProjectsAgentTool, { limit: 2 }))
    expect(first.projects).toHaveLength(2)
    const second = await answer<{ projects: ProjectRow[]; nextCursor?: string }>(run(tools.listProjectsAgentTool, { limit: 2, cursor: first.nextCursor }))
    expect(second.projects).toHaveLength(1)
    expect(second.nextCursor).toBeUndefined()
  })

  test('read_project resolves a folder inside a project and gives its settings and codebases', async () => {
    mkdirSync(join(web, '.solus'))
    writeFileSync(join(web, '.solus', 'config.json'), JSON.stringify({ version: 1, taskDoneOnMerge: true }))
    await codebases.saveCodebase('local', 'host', {
      id: 'stack', name: 'stack', roots: [{ installationId, path: web, name: 'web' }, { installationId, path: api, name: 'api' }], updatedAt: 1, deletedAt: null,
    })
    mkdirSync(join(web, 'src'))
    const read = await answer<{ path: string; settings: { taskDoneOnMerge?: boolean }; codebases: { id: string }[] }>(
      run(tools.readProjectAgentTool, { path: join(web, 'src') }),
    )
    expect(read.path).toBe(web)
    expect(read.settings.taskDoneOnMerge).toBe(true)
    expect(read.codebases).toEqual([{ id: 'stack', name: 'stack' }])
    // A member cannot read a project outside their folder.
    expect((await run(tools.readProjectAgentTool, { path: web }, MEMBER)).ok).toBe(false)
  })

  test('update_project changes only the given settings, and null removes one', async () => {
    mkdirSync(join(web, '.solus'))
    writeFileSync(join(web, '.solus', 'config.json'), JSON.stringify({ version: 1, taskDoneOnMerge: true, codebaseNaming: 'folders' }))
    const updated = await run(tools.updateProjectAgentTool, { path: web, codebase_naming: null, server_urls: ['http://localhost:5173'] })
    expect(updated.ok).toBe(true)
    // WHY: an omitted field is a setting the agent did not mean to touch.
    expect(JSON.parse(readFileSync(join(web, '.solus', 'config.json'), 'utf8'))).toEqual({
      version: 1, taskDoneOnMerge: true, serverUrls: ['http://localhost:5173'],
    })
    expect(await run(tools.updateProjectAgentTool, { path: web })).toMatchObject({ ok: false, text: 'Give at least one setting to change.' })
    // The save keeps its own rules: a URL that is not local is refused.
    expect((await run(tools.updateProjectAgentTool, { path: web, server_urls: ['https://example.com'] })).ok).toBe(false)
  })

  test('delete_project keeps the folder, and a project with sessions needs force', async () => {
    // A record names its project as the encoded folder name.
    await records.upsertSessionRecord('local', { sessionId: 'caller', provider: 'codex', projectPath: encodePathAsFolder(web), lastActivityAt: Date.now() })
    const refused = await run(tools.deleteProjectAgentTool, { path: web })
    expect(refused.ok).toBe(false)
    expect(refused.text).toContain('force: true')
    expect((await manifest.listProjects()).map((project) => project.path)).toContain(web)

    expect(await run(tools.deleteProjectAgentTool, { path: web, force: true })).toMatchObject({ ok: true })
    expect((await manifest.listProjects()).map((project) => project.path)).not.toContain(web)
    // WHY: a delete takes the project off the list. The folder and the session stay.
    expect(existsSync(join(web, '.git'))).toBe(true)
    expect(await records.getSessionRecord('local', 'caller')).not.toBeNull()

    // A project with no session needs no force.
    expect(await run(tools.deleteProjectAgentTool, { path: api })).toMatchObject({ ok: true })
    expect(existsSync(api)).toBe(true)
  })

  test('delete_project refuses a folder inside a project', async () => {
    mkdirSync(join(web, 'src'))
    expect((await run(tools.deleteProjectAgentTool, { path: join(web, 'src'), force: true })).text).toContain('Give the project folder')
    expect((await manifest.listProjects()).map((project) => project.path)).toContain(web)
  })
})

describe('codebase tools', () => {
  let web: string
  let api: string
  let docs: string
  const stack = (): Codebase => ({
    id: 'stack', name: 'stack', updatedAt: 1, deletedAt: null,
    roots: [{ installationId, path: web, name: 'web' }, { installationId, path: api, name: 'api' }],
  })

  beforeEach(async () => {
    web = makeRepository(join(projectsRoot, 'web'))
    api = makeRepository(join(projectsRoot, 'api'))
    docs = makeRepository(join(projectsRoot, 'docs'))
    await codebases.saveCodebase('local', 'host', stack())
  })

  test('list_codebases and read_codebase show the record and the repositories of this host', async () => {
    const listed = await answer<{ codebases: { id: string; folders: { path: string; onThisHost: boolean }[] }[] }>(run(codebaseTools.listCodebasesAgentTool, {}))
    expect(listed.codebases.map((codebase) => codebase.id)).toEqual(['stack'])
    expect(listed.codebases[0]!.folders).toMatchObject([{ path: web, onThisHost: true }, { path: api, onThisHost: true }])
    const read = await answer<{ members: { path: string; state: string }[] }>(run(codebaseTools.readCodebaseAgentTool, { codebase_id: 'stack' }))
    expect(read.members.map((member) => member.path).sort()).toEqual([api, web].sort())
  })

  test('update_codebase renames, adds, and removes folders, and keeps the least number of folders', async () => {
    const updated = await answer<{ name: string; folders: { path: string }[] }>(
      run(codebaseTools.updateCodebaseAgentTool, { codebase_id: 'stack', name: 'platform', add_folders: [docs], remove_folders: [api] }),
    )
    expect(updated.name).toBe('platform')
    expect(updated.folders.map((folder) => folder.path)).toEqual([web, docs])
    const stored = await codebases.getCodebase('local', 'stack')
    expect(stored?.name).toBe('platform')
    expect(stored!.updatedAt).toBeGreaterThan(1)

    // WHY: one project is never a codebase (docs/plans/codebases.md decision 14).
    const refused = await run(codebaseTools.updateCodebaseAgentTool, { codebase_id: 'stack', remove_folders: [docs] })
    expect(refused.ok).toBe(false)
    expect((await codebases.getCodebase('local', 'stack'))?.roots).toHaveLength(2)
    // A folder that is not on the disk is refused before the save.
    expect((await run(codebaseTools.updateCodebaseAgentTool, { codebase_id: 'stack', add_folders: [join(projectsRoot, 'gone')] })).text).toContain('does not exist')
  })

  test('delete_codebase saves a tombstone and keeps the folders', async () => {
    expect(await run(codebaseTools.deleteCodebaseAgentTool, { codebase_id: 'stack' })).toMatchObject({ ok: true })
    // WHY: the delete moves to the other hosts as a newer copy, so the row stays with deletedAt.
    const tombstone = await codebases.getCodebase('local', 'stack')
    expect(tombstone?.deletedAt).not.toBeNull()
    expect(tombstone!.updatedAt).toBeGreaterThan(1)
    expect(await codebases.listCodebases('local')).toEqual([])
    expect(existsSync(join(web, '.git')) && existsSync(join(api, '.git'))).toBe(true)
  })
})

describe('a guest turn', () => {
  test('is refused by each tool where the guest client is refused, and changes nothing', async () => {
    const web = makeRepository(join(projectsRoot, 'web'))
    await manifest.recordProject(web)
    const api = makeRepository(join(projectsRoot, 'api'))
    await codebases.saveCodebase('local', 'host', {
      id: 'stack', name: 'stack', updatedAt: 1, deletedAt: null,
      roots: [{ installationId, path: web, name: 'web' }, { installationId, path: api, name: 'api' }],
    })
    const calls: [AgentTool, Parameters<AgentTool['execute']>[0]][] = [
      [tools.listProjectsAgentTool, {}],
      [tools.readProjectAgentTool, { path: web }],
      [tools.updateProjectAgentTool, { path: web, task_done_on_merge: true }],
      [tools.deleteProjectAgentTool, { path: web, force: true }],
      [codebaseTools.listCodebasesAgentTool, {}],
      [codebaseTools.readCodebaseAgentTool, { codebase_id: 'stack' }],
      [codebaseTools.updateCodebaseAgentTool, { codebase_id: 'stack', name: 'mine' }],
      [codebaseTools.deleteCodebaseAgentTool, { codebase_id: 'stack' }],
    ]
    for (const [tool, input] of calls) {
      expect({ tool: tool.name, ok: (await run(tool, input, GUEST)).ok }).toEqual({ tool: tool.name, ok: false })
    }
    expect((await manifest.listProjects()).map((project) => project.path)).toEqual([web])
    expect(existsSync(join(web, '.solus'))).toBe(false)
    expect(await codebases.getCodebase('local', 'stack')).toMatchObject({ name: 'stack', deletedAt: null })
  })

  test('a call with no admitted turn is refused', async () => {
    expect(await tools.listProjectsAgentTool.execute({}, context)).toMatchObject({ ok: false, text: 'list_projects requires an admitted Solus turn.' })
  })
})
