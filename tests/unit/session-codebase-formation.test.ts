import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { isTaskFolderPath, type Codebase } from '@solus/contracts/codebases'
import type { Activity } from '@solus/contracts/activity'
import type { AgentMetadata, NormalizedEvent, SessionRunInput } from '@solus/contracts/types'
import type { Actor } from '@solus/server/admission/actor'
import type { Principal } from '@solus/server/admission/principal'
import type { AgentBackend, PermissionResponder, RunHandle } from '@solus/server/execution/agents/agent-backend'
import type { AgentRunRequest } from '@solus/server/execution/agents/agent-runner'
import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))
mock.module('@solus/server/git/worktree-name', () => ({ generateWorktreeName: async () => null }))
actAsHostForTests()

// docs/plans/codebases.md decisions 13 and 14. A project covers the
// repositories inside it with no codebase. A codebase has two or more
// folders, and the host makes one only when a real second project is attached
// to a session. A person's "no" (a deleted codebase, "No codebase") is kept.
// Each rule here reads real folders and real repositories, because the disk
// decides.

type Runtime = import('@solus/server/execution/session-runtime').SessionRuntime
type SessionCodebaseEvent = Extract<NormalizedEvent, { type: 'session_codebase' }>
type FormedDivider = Extract<Activity, { kind: 'codebase_formed' }>
const LONG = 60_000

let root: string
let runtimeModule: typeof import('@solus/server/execution/session-runtime')
let codebases: typeof import('@solus/server/data/codebases/codebases')
let records: typeof import('@solus/server/data/sessions/session-records')
let activityRecord: typeof import('@solus/server/data/activity/activity')
let manifest: typeof import('@solus/server/project-config/projects-manifest')
let store: typeof import('@solus/server/git/task-folder-store')
let HOST_ACTOR: Actor
let ANY_ORGANIZATION: typeof import('@solus/server/admission/principal')['ANY_ORGANIZATION']
let installationId: string
const previousEnv = {
  dataDir: process.env.SOLUS_DATA_DIR, globalConfig: process.env.GIT_CONFIG_GLOBAL, systemConfig: process.env.GIT_CONFIG_SYSTEM,
  projectsRoot: process.env.SOLUS_PROJECTS_ROOT,
}
const restoreEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'solus-codebase-formation-')))
  process.env.SOLUS_DATA_DIR = join(root, 'data')
  mkdirSync(join(root, 'data'))
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_SYSTEM = '/dev/null'
  runtimeModule = await import('@solus/server/execution/session-runtime')
  codebases = await import('@solus/server/data/codebases/codebases')
  records = await import('@solus/server/data/sessions/session-records')
  activityRecord = await import('@solus/server/data/activity/activity')
  manifest = await import('@solus/server/project-config/projects-manifest')
  store = await import('@solus/server/git/task-folder-store')
  ;({ HOST_ACTOR } = await import('@solus/server/admission/actor'))
  ;({ ANY_ORGANIZATION } = await import('@solus/server/admission/principal'))
  installationId = (await import('@solus/server/admission/auth')).getInstallationId()
})

afterAll(async () => {
  ;(await import('@solus/server/data/insights/metrics-db')).closeMetricsDb()
  ;(await import('@solus/server/db')).closeDb()
  rmSync(root, { recursive: true, force: true })
  restoreEnv('SOLUS_DATA_DIR', previousEnv.dataDir)
  restoreEnv('GIT_CONFIG_GLOBAL', previousEnv.globalConfig)
  restoreEnv('GIT_CONFIG_SYSTEM', previousEnv.systemConfig)
})

/** A repository with one commit on `main`. */
function repository(path: string): string {
  mkdirSync(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  writeFileSync(join(path, 'README.md'), 'readme\n')
  git(path, 'add', '.')
  git(path, 'commit', '-q', '-m', 'first')
  return path
}

let nextPlace = 0
/** A new folder for one test, so that no codebase of a different test holds it. */
function place(): string {
  const folder = join(root, `place-${++nextPlace}`)
  mkdirSync(folder)
  return folder
}

/** `<place>/shop`, a folder with no repository that holds the repositories `api` and `web`. */
function shop(): { shop: string; api: string; web: string } {
  const folder = join(place(), 'shop')
  return { shop: folder, api: repository(join(folder, 'api')), web: repository(join(folder, 'web')) }
}

function saved(id: string, paths: string[], fields: Partial<Codebase> = {}): Promise<Codebase> {
  return codebases.saveCodebase('local', 'owner', {
    id, name: id, updatedAt: 1_000, deletedAt: null,
    roots: paths.map((path) => ({ installationId, path, name: '' })),
    ...fields,
  })
}

/** The live codebases that have `path` as a root. */
async function codebasesRootedAt(path: string): Promise<Codebase[]> {
  return (await codebases.listCodebases(ANY_ORGANIZATION)).filter((codebase) => codebase.roots.some((each) => each.path === path))
}

interface Watched {
  runtime: Runtime
  /** Each `session_codebase` event of the session. */
  taken: SessionCodebaseEvent[]
  events: NormalizedEvent[]
}

/**
 * Each folder of this file is in the temporary directory of the system, which
 * no automatic trigger attaches (decision 8). These tests are about the
 * formation, so a runtime here has no temporary places.
 */
function runtimeFor(sessionId: string): Watched {
  const runtime = new runtimeModule.SessionRuntime(new Map(), { temporaryPlaces: [] })
  const taken: SessionCodebaseEvent[] = []
  const events: NormalizedEvent[] = []
  runtime.on('event', (id: string, event: NormalizedEvent) => {
    if (id !== sessionId) return
    events.push(event)
    if (event.type === 'session_codebase') taken.push(event)
  })
  return { runtime, taken, events }
}

const pathsOf = (folders: { path: string }[]): string[] => folders.map((folder) => folder.path)

/**
 * Each divider of a codebase that the host made, as the clients of the
 * session got it live: the `codebase_formed` activity. A session that takes a
 * codebase that exists gets none.
 */
function dividersIn(events: NormalizedEvent[]): FormedDivider[] {
  return events.flatMap((event) => (event.type === 'activity' && event.activity.kind === 'codebase_formed' ? [event.activity] : []))
}

/** Each publish of a runtime, and a wait for one that an answer of the database causes. */
function publishesOf(runtime: Runtime) {
  const sent: { event: NormalizedEvent; only?: string }[] = []
  const waits: { isMet: () => boolean; done: () => void }[] = []
  const publish = runtime.publish.bind(runtime)
  runtime.publish = (sessionId, event, audience) => {
    sent.push({ event, only: audience?.only })
    publish(sessionId, event, audience)
    for (const wait of waits.splice(0)) {
      if (wait.isMet()) wait.done()
      else waits.push(wait)
    }
  }
  const until = (isMet: () => boolean) => new Promise<void>((done) => {
    if (isMet()) done()
    else waits.push({ isMet, done })
  })
  return { sent, until }
}

/**
 * A session in a repository that attaches a second repository: the host makes
 * the codebase of the two (rule 2). The names are for one test, so that the
 * name of the codebase is free.
 */
async function sessionWithSecondProject(runtime: Runtime, sessionId: string, names: [string, string]): Promise<{ project: string; second: string; formed: Codebase }> {
  const home = place()
  const project = repository(join(home, names[0]))
  const second = repository(join(home, names[1]))
  await runtime.sessionFolders.resolve(sessionId, { workingDirectory: project, repositoryRoot: project, actor: HOST_ACTOR })
  await runtime.sessionFolders.attach(sessionId, second, 'attached', HOST_ACTOR)
  const [formed] = await codebasesRootedAt(project)
  return { project, second, formed: formed! }
}

describe('rule 1: a session with no codebase takes the one codebase that holds its project folder', () => {
  test('the session takes it, and its folders are the members in the same turn', async () => {
    // WHY: an agent-started session, an automation, and a mobile session name no codebase. They must get the one of the folder.
    const { shop: folder, api, web } = shop()
    const ui = repository(join(place(), 'ui'))
    const codebase = await saved('one-holder', [folder, ui])
    const { runtime, taken, events } = runtimeFor('takes-one')
    try {
      const folders = await runtime.sessionFolders.resolve('takes-one', { workingDirectory: api, repositoryRoot: api, actor: HOST_ACTOR })
      expect(pathsOf(folders).sort()).toEqual([folder, web, ui].sort())
      expect(await runtime.sessionFolders.codebaseIdOf('takes-one')).toBe(codebase.id)
      expect(taken).toEqual([{ type: 'session_codebase', codebaseId: codebase.id, name: 'one-holder' }])
      // The session took a codebase that exists: the conversation gets no divider, live or stored.
      expect(dividersIn(events)).toEqual([])
      expect(await activityRecord.activityFor(ANY_ORGANIZATION, { kind: 'session', id: 'takes-one' })).toEqual([])
      // Nothing was made: the folder still has one codebase.
      expect(await codebases.codebasesOfFolder(ANY_ORGANIZATION, installationId, api)).toHaveLength(1)
    } finally {
      runtime.shutdown()
    }
  })

  test('a folder that two codebases hold gives none, and nothing is formed', async () => {
    const { shop: folder } = shop()
    await saved('first-holder', [folder, repository(join(place(), 'ui'))])
    await saved('second-holder', [folder, repository(join(place(), 'docs'))])
    const { runtime, taken } = runtimeFor('two-holders')
    try {
      await runtime.sessionFolders.resolve('two-holders', { workingDirectory: folder, actor: HOST_ACTOR })
      expect(await runtime.sessionFolders.codebaseIdOf('two-holders')).toBeNull()
      expect(taken).toEqual([])
      expect(await codebases.codebasesOfFolder(ANY_ORGANIZATION, installationId, folder)).toHaveLength(2)
    } finally {
      runtime.shutdown()
    }
  })
})

describe('a project covers the repositories inside it, with no codebase (decision 14)', () => {
  test('a folder with two repositories gives both to the session, and no codebase is made', async () => {
    // WHY: a codebase from one folder had the same name as its project, so the project picker showed one thing two times.
    // A project is never also a codebase: the repositories inside it come with the project.
    const { shop: folder, api, web } = shop()
    await records.upsertOwnSessionRecord({ sessionId: 'project-shop', provider: 'codex', projectPath: '-shop', lastActivityAt: 1_000 })
    const { runtime, taken, events } = runtimeFor('project-shop')
    try {
      const folders = await runtime.sessionFolders.resolve('project-shop', { workingDirectory: folder, actor: HOST_ACTOR })

      expect(folders).toEqual([
        { path: api, name: 'api', state: 'git', repositoryPath: api, source: 'project', granted: true },
        { path: web, name: 'web', state: 'git', repositoryPath: web, source: 'project', granted: true },
      ])
      // The repositories are in the working directory: the provider reaches them with no grant.
      expect(runtime.sessionFolders.grantedPaths('project-shop')).toEqual([])
      // Each repository gets its own checkpoint, as a member of a codebase does.
      expect(pathsOf(runtime.sessionFolders.checkpointTargets('project-shop'))).toEqual([api, web])
      // The agent is told about the folders. The block has no name, because there is no codebase.
      expect(runtime.sessionFolders.promptFolders('project-shop')).toMatchObject({ name: null, folders: [{ path: api }, { path: web }], otherHosts: [] })

      expect(await codebases.listCodebases(ANY_ORGANIZATION, { includeDeleted: true })).not.toContainEqual(expect.objectContaining({ roots: [expect.objectContaining({ path: folder })] }))
      expect(await codebasesRootedAt(folder)).toEqual([])
      expect((await records.storedSessionFolders('project-shop'))?.codebaseId ?? null).toBeNull()
      expect(taken).toEqual([])
      expect(dividersIn(events)).toEqual([])
      // A repository of the project cannot leave the session: it comes with the project.
      await expect(runtime.sessionFolders.detach('project-shop', api, HOST_ACTOR)).rejects.toThrow(/project folder/)
    } finally {
      runtime.shutdown()
    }
  })

  test('a folder with no repository inside it gives no folder', async () => {
    const folder = join(place(), 'notes')
    mkdirSync(join(folder, 'drafts'), { recursive: true })
    const alone = repository(join(place(), 'alone'))
    const { runtime, taken } = runtimeFor('nothing-inside')
    try {
      expect(await runtime.sessionFolders.resolve('nothing-inside', { workingDirectory: folder, actor: HOST_ACTOR })).toEqual([])
      // A repository with no repository inside it is one folder.
      expect(await runtime.sessionFolders.resolve('nothing-inside', { workingDirectory: alone, repositoryRoot: alone, actor: HOST_ACTOR })).toEqual([])
      expect(taken).toEqual([])
      expect(runtime.sessionFolders.promptFolders('nothing-inside')).toBeUndefined()
    } finally {
      runtime.shutdown()
    }
  })

  test('a repository that holds a nested repository gives the nested one', async () => {
    const outer = repository(join(place(), 'platform'))
    const nested = repository(join(outer, 'services', 'billing'))
    const { runtime, taken } = runtimeFor('nested')
    try {
      // The session works in a subfolder: its project folder is the root of the repository.
      const folders = await runtime.sessionFolders.resolve('nested', { workingDirectory: join(outer, 'services'), repositoryRoot: outer, actor: HOST_ACTOR })
      expect(folders.map(({ path, source }) => ({ path, source }))).toEqual([{ path: nested, source: 'project' }])
      expect(taken).toEqual([])
      expect(await codebasesRootedAt(outer)).toEqual([])
    } finally {
      runtime.shutdown()
    }
  })

  test('a session in a worktree gets the repositories of the original folder, never of the worktree', async () => {
    const outer = repository(join(place(), 'platform'))
    const nested = repository(join(outer, 'services', 'billing'))
    const worktree = join(outer, '.git', 'solus', 'worktrees', 'fix')
    git(outer, 'worktree', 'add', '-q', '-b', 'fix', worktree)
    const { runtime } = runtimeFor('in-worktree')
    try {
      const folders = await runtime.sessionFolders.resolve('in-worktree', { workingDirectory: worktree, repositoryRoot: outer, actor: HOST_ACTOR })
      expect(folders.map(({ path, source }) => ({ path, source }))).toEqual([{ path: nested, source: 'project' }])
      // The repository is not in the worktree, so the provider gets a grant for it.
      expect(runtime.sessionFolders.grantedPaths('in-worktree')).toContain(nested)
      expect(await codebasesRootedAt(outer)).toEqual([])
    } finally {
      runtime.shutdown()
    }
  })

  test('a chat, the home directory, the projects root, and a guest get no repository', async () => {
    // WHY: these folders hold much more than one piece of work, and a guest stays in the checkout of the shared session.
    // The home directory of the person who runs the test: the rule stops before it reads the folder.
    const home = homedir()
    const projects = join(place(), 'projects')
    repository(join(projects, 'api'))
    const chat = join(root, 'data', 'solus-chats', 'chat1')
    repository(join(chat, 'scratch'))
    const { shop: folder } = shop()
    const guest: Principal = {
      kind: 'guest', guestId: 'g1', displayName: 'Maya', deviceId: 'g1', deviceLabel: 'Guest link', expiresAt: Date.now() + 300_000,
      share: { resource: { kind: 'session', id: 'guest-session' }, role: 'editor', sharedByUserId: 'owner', linkSecretHash: 'hash' },
    }
    process.env.SOLUS_PROJECTS_ROOT = projects
    const { runtime, taken } = runtimeFor('special')
    try {
      for (const workingDirectory of [home, projects, chat]) {
        expect(await runtime.sessionFolders.resolve('special', { workingDirectory, actor: HOST_ACTOR })).toEqual([])
      }
      expect(await runtime.sessionFolders.resolve('special', { workingDirectory: folder, actor: { principal: guest, user: null } })).toEqual([])
      expect(taken).toEqual([])
    } finally {
      runtime.shutdown()
      restoreEnv('SOLUS_PROJECTS_ROOT', previousEnv.projectsRoot)
    }
  })
})

describe('rule 2: a second project that is attached in a session with no codebase forms a codebase', () => {
  test('a repository that is attached on purpose forms a codebase with two roots, named with both', async () => {
    // WHY: a session in `~/solus` that is told to change `~/solus-cloud`. The next session there must start with both.
    // The name has both folders: a codebase with the name of the project alone reads as the project.
    const home = place()
    const solus = repository(join(home, 'solus'))
    const cloud = repository(join(home, 'solus-cloud'))
    await records.upsertOwnSessionRecord({ sessionId: 'attaches', provider: 'codex', projectPath: '-solus', lastActivityAt: 1_000 })
    const { runtime, taken, events } = runtimeFor('attaches')
    try {
      await runtime.sessionFolders.resolve('attaches', { workingDirectory: solus, repositoryRoot: solus, actor: HOST_ACTOR })
      expect(taken).toEqual([])
      const folders = await runtime.sessionFolders.attach('attaches', cloud, 'attached', HOST_ACTOR)

      const [formed] = await codebasesRootedAt(solus)
      expect(formed).toMatchObject({ name: 'solus + solus-cloud', roots: [{ installationId, path: solus, name: '' }, { installationId, path: cloud, name: '' }] })
      expect(taken).toEqual([{ type: 'session_codebase', codebaseId: formed!.id, name: 'solus + solus-cloud' }])
      // The divider names the two folders that the codebase was made from, the project folder first.
      // Its author is the actor of the attach, who is the creator of the codebase: the host here.
      expect(dividersIn(events)).toMatchObject([{
        kind: 'codebase_formed', codebaseId: formed!.id, name: 'solus + solus-cloud', folders: ['solus', 'solus-cloud'],
        subject: { kind: 'session', id: 'attaches' }, by: { kind: 'system' },
      }])
      // The attached folder is a member of the codebase now.
      expect(folders).toEqual([{ path: cloud, name: 'solus-cloud', state: 'git', repositoryPath: cloud, source: 'codebase', granted: true }])
      // The agent is told about the codebase.
      expect(runtime.sessionFolders.promptFolders('attaches')).toMatchObject({ name: 'solus + solus-cloud', folders: [{ path: cloud }] })
      // The record of the session keeps the codebase, so a restart of the host forms no second one.
      expect((await records.storedSessionFolders('attaches'))?.codebaseId).toBe(formed!.id)

      // The next session in the folder starts with both folders, with no manual step.
      const next = runtimeFor('next-session')
      try {
        expect(pathsOf(await next.runtime.sessionFolders.resolve('next-session', { workingDirectory: solus, repositoryRoot: solus, actor: HOST_ACTOR }))).toEqual([cloud])
        expect(next.taken).toEqual([{ type: 'session_codebase', codebaseId: formed!.id, name: 'solus + solus-cloud' }])
        // The next session takes the codebase that exists: it gets no divider.
        expect(dividersIn(next.events)).toEqual([])
      } finally {
        next.runtime.shutdown()
      }
    } finally {
      runtime.shutdown()
    }
  })

  test('the divider is in the history that a reload and a second client read, at the place where the codebase formed', async () => {
    // WHY: a toast was gone after a reload. The divider is a stored activity, as a move into a worktree is,
    // so each reader gets the same line at the same place.
    const { runtime, events } = runtimeFor('reloads')
    try {
      await sessionWithSecondProject(runtime, 'reloads', ['reloads-app', 'reloads-lib'])
      const [live] = dividersIn(events)
      const stored = await activityRecord.activityFor(ANY_ORGANIZATION, { kind: 'session', id: 'reloads' })
      expect(stored).toEqual([live!])
      // The provider writes the prompt after the turn start, and its answer after that: the divider is before the two.
      const history = [
        { messageId: 'earlier', role: 'assistant' as const, content: 'An answer of a turn before.', timestamp: live!.at - 10 },
        { messageId: 'prompt', role: 'user' as const, content: 'do the work', timestamp: live!.at + 5 },
        { messageId: 'answer', role: 'assistant' as const, content: 'Done.', timestamp: live!.at + 50 },
      ]
      const read = activityRecord.mergeWindowActivity(history, stored, false)
      expect(read.map((row) => row.messageId)).toEqual(['earlier', `activity:${live!.id}`, 'prompt', 'answer'])
      expect(read[1]!.activity).toEqual(live!)
    } finally {
      runtime.shutdown()
    }
  })

  test('a client that starts to watch the session gets the codebase, and no second divider', async () => {
    // WHY: the divider is written one time, when the codebase forms. A client that connects later reads it in the history.
    const runtime = new runtimeModule.SessionRuntime(new Map(), { temporaryPlaces: [] })
    const { sent, until } = publishesOf(runtime)
    try {
      const { formed } = await sessionWithSecondProject(runtime, 'replayed', ['replayed-app', 'replayed-lib'])
      sent.length = 0
      runtime.sessionFolders.replayTo('replayed', 'client-2')
      // The folders go at once: a `git_context` that names one of them can come next.
      expect(sent.map(({ event }) => event.type)).toEqual(['session_folders'])
      // The codebase goes after a read of its record.
      await until(() => sent.length === 2)
      expect(sent[1]).toEqual({ event: { type: 'session_codebase', codebaseId: formed.id, name: formed.name }, only: 'client-2' })
      expect(await activityRecord.activityFor(ANY_ORGANIZATION, { kind: 'session', id: 'replayed' })).toHaveLength(1)
    } finally {
      runtime.shutdown()
    }
  })

  test('a client that starts to watch after the delete does not get the deleted codebase', async () => {
    // WHY: a person deletes the codebase, and the session keeps its copy until the next turn start.
    // A client that connects before that turn must not show a codebase that does not exist.
    const runtime = new runtimeModule.SessionRuntime(new Map(), { temporaryPlaces: [] })
    const { sent, until } = publishesOf(runtime)
    const typesSentTo = (clientId: string) => sent.filter(({ only }) => only === clientId).map(({ event }) => event.type)
    try {
      const { formed } = await sessionWithSecondProject(runtime, 'undone-watch', ['undone-app', 'undone-lib'])
      await sessionWithSecondProject(runtime, 'kept-watch', ['kept-app', 'kept-lib'])
      // The delete: the client saves the record with `deletedAt`.
      await codebases.saveCodebase('local', 'owner', { ...formed, updatedAt: formed.updatedAt + 1, deletedAt: formed.updatedAt + 1 })
      runtime.sessionFolders.replayTo('undone-watch', 'client-2')
      // The replay of a session whose codebase exists starts later, so its codebase arrives after the first replay sent all that it sends.
      runtime.sessionFolders.replayTo('kept-watch', 'client-3')
      await until(() => typesSentTo('client-3').includes('session_codebase'))
      expect(typesSentTo('client-2')).toEqual(['session_folders'])
    } finally {
      runtime.shutdown()
    }
  })

  test('a folder with no repository forms no codebase, and stays a folder of that session', async () => {
    // WHY: a person pasted a screenshot, and the folder of the file was attached. A codebase formed from the project
    // and that folder, and each later session of the project got the folder. Only a real second project of the work
    // (a repository, a listed project) makes a codebase.
    const home = place()
    const solus = repository(join(home, 'solus'))
    const screenshots = join(home, 'screenshots')
    const created = join(home, 'created')
    for (const folder of [screenshots, created]) mkdirSync(folder)
    const { runtime, taken, events } = runtimeFor('attaches-plain')
    try {
      await runtime.sessionFolders.resolve('attaches-plain', { workingDirectory: solus, repositoryRoot: solus, actor: HOST_ACTOR })
      // Each source that a person or the agent causes: a person's attach, the attach rule, and a project tool.
      const folders = await runtime.sessionFolders.attach('attaches-plain', screenshots, 'attached', HOST_ACTOR)
      expect(await runtime.sessionFolders.adoptCreated('attaches-plain', created, true, HOST_ACTOR)).toEqual({ addedToCodebase: false })

      expect(await codebasesRootedAt(solus)).toEqual([])
      expect(taken).toEqual([])
      expect(dividersIn(events)).toEqual([])
      // The session that attached the folder has it.
      expect(folders).toEqual([{ path: screenshots, name: 'screenshots', state: 'plain', repositoryPath: screenshots, source: 'attached', granted: true }])

      // The next session in the project gets no codebase and no folder.
      const next = runtimeFor('after-plain')
      try {
        expect(await next.runtime.sessionFolders.resolve('after-plain', { workingDirectory: solus, repositoryRoot: solus, actor: HOST_ACTOR })).toEqual([])
        expect(next.taken).toEqual([])
      } finally {
        next.runtime.shutdown()
      }
    } finally {
      runtime.shutdown()
    }
  })

  test('a repository in the project folder, and a folder that holds the project folder, form no codebase', async () => {
    // WHY: the project covers what is inside it, so such a folder is no second project.
    // A codebase of a folder and a folder inside it has one root too many.
    const home = place()
    const parent = repository(join(home, 'mono'))
    const project = repository(join(parent, 'apps', 'site'))
    const deep = repository(join(project, 'a', 'b', 'c'))
    await manifest.recordProject(parent)
    const { runtime, taken } = runtimeFor('attaches-inside')
    try {
      await runtime.sessionFolders.resolve('attaches-inside', { workingDirectory: project, repositoryRoot: project, actor: HOST_ACTOR })
      // Too deep for the discovery of the project, so a person attaches it.
      await runtime.sessionFolders.attach('attaches-inside', deep, 'attached', HOST_ACTOR)
      await runtime.sessionFolders.attach('attaches-inside', parent, 'attached', HOST_ACTOR)
      expect(taken).toEqual([])
      expect(await codebasesRootedAt(project)).toEqual([])
      expect(runtime.sessionFolders.foldersOf('attaches-inside').map(({ path, source }) => ({ path, source }))).toEqual([
        { path: parent, source: 'attached' },
        { path: deep, source: 'attached' },
      ])
    } finally {
      runtime.shutdown()
    }
  })

  test('a folder with no repository in a project that this host lists forms a codebase', async () => {
    const home = place()
    const work = repository(join(home, 'work'))
    const designs = join(home, 'designs')
    mkdirSync(designs)
    await manifest.recordProject(designs)
    const { runtime, taken } = runtimeFor('attaches-listed')
    try {
      await runtime.sessionFolders.resolve('attaches-listed', { workingDirectory: work, repositoryRoot: work, actor: HOST_ACTOR })
      await runtime.sessionFolders.attach('attaches-listed', designs, 'attached', HOST_ACTOR)
      const [formed] = await codebasesRootedAt(work)
      expect(formed?.roots.map((each) => each.path)).toEqual([work, designs])
      expect(taken).toMatchObject([{ codebaseId: formed!.id, name: 'work + designs' }])
    } finally {
      runtime.shutdown()
    }
  })

  test('a folder that Solus only saw a write in forms a codebase only when it is a listed project', async () => {
    const home = place()
    const work = repository(join(home, 'observer'))
    const stray = repository(join(home, 'stray'))
    const listed = repository(join(home, 'listed'))
    await manifest.recordProject(listed)
    const { runtime, taken, events } = runtimeFor('observes')
    try {
      await runtime.sessionFolders.resolve('observes', { workingDirectory: work, repositoryRoot: work, actor: HOST_ACTOR })
      await runtime.sessionFolders.attach('observes', stray, 'observed', HOST_ACTOR)
      expect(taken).toEqual([])
      expect(await codebasesRootedAt(work)).toEqual([])

      await runtime.sessionFolders.attach('observes', listed, 'observed', HOST_ACTOR)
      const [formed] = await codebasesRootedAt(work)
      expect(formed?.roots.map((each) => each.path)).toEqual([work, listed])
      expect(taken).toMatchObject([{ codebaseId: formed!.id }])
      expect(dividersIn(events)).toMatchObject([{ codebaseId: formed!.id, folders: ['observer', 'listed'] }])
    } finally {
      runtime.shutdown()
    }
  })

  test('an attach in a session that has a codebase adds no root', async () => {
    const { shop: folder, api } = shop()
    const ui = repository(join(place(), 'ui'))
    const other = repository(join(place(), 'other'))
    const codebase = await saved('kept-roots', [folder, ui])
    const { runtime, taken } = runtimeFor('has-codebase')
    try {
      await runtime.sessionFolders.resolve('has-codebase', { workingDirectory: api, repositoryRoot: api, codebaseId: codebase.id, actor: HOST_ACTOR })
      const folders = await runtime.sessionFolders.attach('has-codebase', other, 'attached', HOST_ACTOR)
      // The folder is for this session only: its row offers "Add to codebase".
      expect(folders.find((each) => each.path === other)?.source).toBe('attached')
      expect((await codebases.getCodebase(ANY_ORGANIZATION, codebase.id))?.roots.map((each) => each.path)).toEqual([folder, ui])
      expect(await codebasesRootedAt(other)).toEqual([])
      expect(taken).toEqual([])
    } finally {
      runtime.shutdown()
    }
  })

  test('a project that a tool made outside the project folder forms a codebase with it, unless the caller keeps it out', async () => {
    // WHY: `create_project` and `clone_project` make the second project of the work. `add_to_codebase: false` says that it is not.
    const home = place()
    const work = repository(join(home, 'tooled'))
    const kept = repository(join(home, 'kept-out'))
    const made = repository(join(home, 'made'))
    const { runtime, taken } = runtimeFor('creates')
    try {
      await runtime.sessionFolders.resolve('creates', { workingDirectory: work, repositoryRoot: work, actor: HOST_ACTOR })
      expect(await runtime.sessionFolders.adoptCreated('creates', kept, false, HOST_ACTOR)).toEqual({ addedToCodebase: false })
      expect(await codebasesRootedAt(work)).toEqual([])
      expect(taken).toEqual([])

      expect(await runtime.sessionFolders.adoptCreated('creates', made, true, HOST_ACTOR)).toEqual({ addedToCodebase: true })
      expect((await codebasesRootedAt(work))[0]).toMatchObject({ name: 'tooled + made', roots: [{ path: work }, { path: made }] })
      // The folder that the caller kept out stays a folder of this session only.
      expect(runtime.sessionFolders.foldersOf('creates').map(({ path, source }) => ({ path, source }))).toEqual([
        { path: kept, source: 'created' },
        { path: made, source: 'codebase' },
      ])
    } finally {
      runtime.shutdown()
    }
  })

  test('a project that a tool made in the project folder needs no codebase: the project covers it', async () => {
    const work = join(place(), 'workspace')
    repository(join(work, 'api'))
    const { runtime, taken } = runtimeFor('creates-inside')
    try {
      await runtime.sessionFolders.resolve('creates-inside', { workingDirectory: work, actor: HOST_ACTOR })
      const made = repository(join(work, 'web'))
      expect(await runtime.sessionFolders.adoptCreated('creates-inside', made, true, HOST_ACTOR)).toEqual({ addedToCodebase: false })
      expect(runtime.sessionFolders.foldersOf('creates-inside').map(({ path, source }) => ({ path, source }))).toEqual([
        { path: join(work, 'api'), source: 'project' },
        { path: made, source: 'project' },
      ])
      expect(taken).toEqual([])
      expect(await codebasesRootedAt(work)).toEqual([])
    } finally {
      runtime.shutdown()
    }
  })

  test('a folder attached before the first turn forms the codebase at that turn start, when the choice of the person is known', async () => {
    // WHY: the prompt trigger attaches before the launch. A draft with "No codebase" must stay with none.
    const home = place()
    const work = repository(join(home, 'early'))
    const named = repository(join(home, 'named'))
    const refuses = runtimeFor('says-no')
    const accepts = runtimeFor('says-nothing')
    try {
      await refuses.runtime.sessionFolders.requestAttach('says-no', named, 'attached', HOST_ACTOR, { mode: 'full-access', workingDirectory: work })
      expect(await codebasesRootedAt(work)).toEqual([])
      await refuses.runtime.sessionFolders.resolve('says-no', { workingDirectory: work, repositoryRoot: work, noCodebase: true, actor: HOST_ACTOR })
      expect(await codebasesRootedAt(work)).toEqual([])

      await accepts.runtime.sessionFolders.requestAttach('says-nothing', named, 'attached', HOST_ACTOR, { mode: 'full-access', workingDirectory: work })
      await accepts.runtime.sessionFolders.resolve('says-nothing', { workingDirectory: work, repositoryRoot: work, actor: HOST_ACTOR })
      expect((await codebasesRootedAt(work))[0]?.roots.map((each) => each.path)).toEqual([work, named])
      expect(dividersIn(accepts.events)).toMatchObject([{ folders: ['early', 'named'] }])
      expect(dividersIn(refuses.events)).toEqual([])
    } finally {
      refuses.runtime.shutdown()
      accepts.runtime.shutdown()
    }
  })
})

describe('the name, the lock, and a person\'s "no"', () => {
  test('a name that a live codebase has gets a number', async () => {
    const names: string[] = []
    for (const sessionId of ['names-1', 'names-2', 'names-3']) {
      const { runtime, taken } = runtimeFor(sessionId)
      try {
        await sessionWithSecondProject(runtime, sessionId, ['alpha', 'beta'])
        names.push(...taken.map((event) => event.name))
      } finally {
        runtime.shutdown()
      }
    }
    expect(names).toEqual(['alpha + beta', 'alpha + beta 2', 'alpha + beta 3'])
  })

  test('two sessions that attach one project at the same moment give one codebase', async () => {
    const home = place()
    const project = repository(join(home, 'same-moment'))
    const second = repository(join(home, 'same-second'))
    const first = runtimeFor('same-moment-1')
    const other = runtimeFor('same-moment-2')
    try {
      await first.runtime.sessionFolders.resolve('same-moment-1', { workingDirectory: project, repositoryRoot: project, actor: HOST_ACTOR })
      await other.runtime.sessionFolders.resolve('same-moment-2', { workingDirectory: project, repositoryRoot: project, actor: HOST_ACTOR })
      await Promise.all([
        first.runtime.sessionFolders.attach('same-moment-1', second, 'attached', HOST_ACTOR),
        other.runtime.sessionFolders.attach('same-moment-2', second, 'attached', HOST_ACTOR),
      ])
      const formed = await codebasesRootedAt(project)
      expect(formed).toHaveLength(1)
      const events = [...first.taken, ...other.taken]
      expect(events.map((event) => event.codebaseId)).toEqual([formed[0]!.id, formed[0]!.id])
      // One session made it, and its conversation has the divider. The other one took it.
      expect([dividersIn(first.events).length, dividersIn(other.events).length].sort()).toEqual([0, 1])
    } finally {
      first.runtime.shutdown()
      other.runtime.shutdown()
    }
  })

  test('a deleted codebase stops the rule that would make a codebase with the same roots, and not rule 1', async () => {
    // WHY: a person deletes the codebase that the host made. The host must not make it again.
    const { runtime, taken } = runtimeFor('undone')
    const later = runtimeFor('undone-later')
    try {
      const { project, second, formed } = await sessionWithSecondProject(runtime, 'undone', ['undone-project', 'undone-second'])
      expect(formed.roots.map((each) => each.path)).toEqual([project, second])
      await codebases.saveCodebase('local', 'owner', { ...formed, updatedAt: formed.updatedAt + 1, deletedAt: Date.now() })

      // The session whose codebase was deleted is a session with no codebase. Its attached folder stays a folder of the session.
      const folders = await runtime.sessionFolders.resolve('undone', { workingDirectory: project, repositoryRoot: project, actor: HOST_ACTOR })
      expect(folders.map(({ path, source }) => ({ path, source }))).toEqual([{ path: second, source: 'attached' }])
      expect(await codebasesRootedAt(project)).toEqual([])
      expect(taken).toHaveLength(1)

      // A later session that attaches the same repository would make the same codebase: the attach is for the session only.
      expect(await later.runtime.sessionFolders.resolve('undone-later', { workingDirectory: project, repositoryRoot: project, actor: HOST_ACTOR })).toEqual([])
      const attached = await later.runtime.sessionFolders.attach('undone-later', second, 'attached', HOST_ACTOR)
      expect(attached.map(({ path, source }) => ({ path, source }))).toEqual([{ path: second, source: 'attached' }])
      expect(await codebasesRootedAt(project)).toEqual([])
      expect(later.taken).toEqual([])

      // A codebase that a person makes by hand is taken: rule 1 does not read the deleted ones.
      const byHand = await saved('made-by-hand', [project, second])
      await runtime.sessionFolders.resolve('undone', { workingDirectory: project, repositoryRoot: project, actor: HOST_ACTOR })
      expect(await runtime.sessionFolders.codebaseIdOf('undone')).toBe(byHand.id)
      expect(taken.at(-1)).toEqual({ type: 'session_codebase', codebaseId: byHand.id, name: 'made-by-hand' })
    } finally {
      runtime.shutdown()
      later.runtime.shutdown()
    }
  })

  test('a deleted codebase with a different set of roots does not stop a formation', async () => {
    // WHY: Solus made a wrong codebase from `~/solus` and a temporary folder, and the person deleted it. That delete
    // says nothing about `~/solus` with `~/solus-cloud`: it must still form.
    const home = place()
    const solus = repository(join(home, 'solus'))
    const cloud = repository(join(home, 'solus-cloud'))
    const screenshots = join(home, 'screenshots')
    mkdirSync(screenshots)
    await saved('wrong-solus', [solus, screenshots], { deletedAt: 2_000, updatedAt: 2_000 })
    // The system deleted the temporary folder: the deleted codebase still names it.
    rmSync(screenshots, { recursive: true })

    const withCloud = runtimeFor('forms-with-cloud')
    try {
      await withCloud.runtime.sessionFolders.resolve('forms-with-cloud', { workingDirectory: solus, repositoryRoot: solus, actor: HOST_ACTOR })
      await withCloud.runtime.sessionFolders.attach('forms-with-cloud', cloud, 'attached', HOST_ACTOR)
      expect((await codebasesRootedAt(solus))[0]?.roots.map((each) => each.path)).toEqual([solus, cloud])
      expect(dividersIn(withCloud.events)).toMatchObject([{ folders: ['solus', 'solus-cloud'] }])
    } finally {
      withCloud.runtime.shutdown()
    }
  })

  test('a session that started with "No codebase" keeps none, and keeps the repositories of its project', async () => {
    const { shop: folder, api, web } = shop()
    const other = repository(join(place(), 'other'))
    const held = shop()
    await saved('held-by-one', [held.shop, repository(join(place(), 'held-ui'))])
    const { runtime, taken } = runtimeFor('no-codebase')
    try {
      // "No codebase" takes no repository of the project away: the project covers them.
      expect(pathsOf(await runtime.sessionFolders.resolve('no-codebase', { workingDirectory: folder, noCodebase: true, actor: HOST_ACTOR }))).toEqual([api, web])
      // A later turn that does not say it again changes nothing: the choice is kept for the session.
      await runtime.sessionFolders.resolve('no-codebase', { workingDirectory: folder, actor: HOST_ACTOR })
      await runtime.sessionFolders.attach('no-codebase', other, 'attached', HOST_ACTOR)
      // Rule 1 also gives none.
      await runtime.sessionFolders.resolve('no-codebase', { workingDirectory: held.shop, actor: HOST_ACTOR })
      expect(taken).toEqual([])
      expect(await codebasesRootedAt(folder)).toEqual([])
      expect(await runtime.sessionFolders.codebaseIdOf('no-codebase')).toBeNull()

      // The person chooses a codebase: the session takes it.
      const chosen = await saved('chosen-later', [folder, repository(join(place(), 'chosen-ui'))])
      await runtime.sessionFolders.resolve('no-codebase', { workingDirectory: folder, codebaseId: chosen.id, actor: HOST_ACTOR })
      expect(await runtime.sessionFolders.codebaseIdOf('no-codebase')).toBe(chosen.id)
    } finally {
      runtime.shutdown()
    }
  })
})

class Permissions implements PermissionResponder {
  getPendingInfo(): undefined { return undefined }
  respondToPermission(): boolean { return false }
  respondToQuestion(): boolean { return false }
  clearPendingForSession(): void {}
  setCurrentSessionId(): void {}
}

/** A backend that records each run it is handed and starts it at once. The run does not end. */
class RecordingBackend extends EventEmitter implements AgentBackend {
  readonly id = 'claude-code' as const
  readonly metadata: AgentMetadata = { id: 'claude-code', label: 'Claude Code', models: [], defaultModel: 'claude-sonnet-5' }
  readonly permissions = new Permissions()
  readonly runs: AgentRunRequest[] = []

  startRun(request: AgentRunRequest): RunHandle {
    this.runs.push(request)
    return {
      agentSessionId: `claude-${this.runs.length}`,
      persistence: request.persistence,
      startedAt: Date.now(),
      toolCallCount: 0,
      sawPermissionRequest: false,
      permissionDenials: [],
      abortController: new AbortController(),
      runPromise: new Promise<void>(() => {}),
      _resolveRun: () => {},
      _rejectRun: () => {},
    }
  }

  getSessionHandle(): RunHandle | undefined { return undefined }
  getPendingHandles(): RunHandle[] { return [] }
  cancelSession(): boolean { return false }
  isSessionRunning(): boolean { return false }
  async steerSession(): Promise<null> { return null }
  loadHistory(): Promise<never[]> { return Promise.resolve([]) }
  loadSessionSkills(): Promise<never[]> { return Promise.resolve([]) }
  getEnrichedError() { return { message: 'failed', isError: true, stderrTail: [] } }
}

function input(workingDirectory: string, overrides: Partial<SessionRunInput> = {}): SessionRunInput {
  return {
    codebaseId: null, provider: 'claude-code', agentSessionId: null, forked: false, workingDirectory, projectPath: workingDirectory,
    gitContext: null, worktreeBaseBranch: null, worktreeRepositories: null, contextWindow: null,
    model: 'claude-opus-5', preferredModel: 'claude-opus-5', reasoningEffort: 'medium', fastMode: false,
    permissionMode: 'supervised', rateLimitBehavior: 'queue', extraInstructions: '',
    ...overrides,
  }
}

describe('the launch of a turn', () => {
  async function start(runInput: SessionRunInput, sessionId: string): Promise<{ run: AgentRunRequest; events: NormalizedEvent[]; runtime: Runtime }> {
    const backend = new RecordingBackend()
    const runtime = new runtimeModule.SessionRuntime(new Map([['claude-code', backend]]))
    runtime.on('error', () => {})
    const events: NormalizedEvent[] = []
    runtime.on('event', (id: string, event: NormalizedEvent) => { if (id === sessionId) events.push(event) })
    const lifecycle = await runtime.runTurn({ target: { kind: 'new-session' }, sessionId, input: runInput, tools: [], options: { prompt: 'do the work', promptSource: 'typed' } })
    await lifecycle.agentSessionId
    return { run: backend.runs.at(-1)!, events, runtime }
  }

  test('the first turn in a folder with repositories gets the block of its folders, with no name and no codebase', async () => {
    const { shop: folder, api, web } = shop()
    const { run, events, runtime } = await start(input(folder), 'first-turn')
    try {
      expect(run.codebase).toEqual({
        name: null,
        workingDirectory: { name: 'shop', path: folder, state: 'plain' },
        folders: [{ name: 'api', path: api, state: 'git' }, { name: 'web', path: web, state: 'git' }],
        otherHosts: [],
      })
      expect(events.some((event) => event.type === 'session_codebase')).toBe(false)
      expect(dividersIn(events)).toEqual([])
      expect(await codebasesRootedAt(folder)).toEqual([])
    } finally {
      runtime.shutdown()
    }
  }, LONG)

  test('the first worktree session in a plain folder with repositories gets a task folder with each one, and no codebase exists after it', async () => {
    // WHY: the plan of a new worktree reads the repositories of the project. A session with no codebase got no task folder before.
    const { shop: folder, api, web } = shop()
    const before = (await codebases.listCodebases(ANY_ORGANIZATION, { includeDeleted: true })).length
    const { run, events, runtime } = await start(input(folder, { worktreeBaseBranch: 'main' }), 'first-worktree')
    try {
      expect(isTaskFolderPath(run.cwd)).toBe(true)
      const taskFolder = store.findTaskFolderContaining(run.cwd)!
      expect(taskFolder).toMatchObject({ primaryRepositoryPath: folder, primaryIsWorktree: false })
      expect(taskFolder.repositories.map((each) => each.repositoryPath).sort()).toEqual([api, web])
      // The worktrees stand in for the repositories of the project.
      expect(runtime.sessionFolders.foldersOf('first-worktree').map(({ path, repositoryPath, source }) => ({ path, repositoryPath, source }))).toEqual([
        { path: join(run.cwd, 'api'), repositoryPath: api, source: 'project' },
        { path: join(run.cwd, 'web'), repositoryPath: web, source: 'project' },
      ])
      expect(await codebases.listCodebases(ANY_ORGANIZATION, { includeDeleted: true })).toHaveLength(before)
      expect(events.some((event) => event.type === 'session_codebase')).toBe(false)
    } finally {
      runtime.shutdown()
    }
  }, LONG)

  test('a worktree session of a repository that holds a repository gets a worktree of each, also with "No codebase"', async () => {
    // WHY: "No codebase" is about a codebase. The repositories of the project come with the project.
    const outer = repository(join(place(), 'platform'))
    const nested = repository(join(outer, 'services', 'billing'))
    const { run, events, runtime } = await start(input(outer, { worktreeBaseBranch: 'main', noCodebase: true }), 'no-codebase-worktree')
    try {
      expect(isTaskFolderPath(run.cwd)).toBe(true)
      expect(store.findTaskFolderContaining(run.cwd)).toMatchObject({ primaryRepositoryPath: outer, primaryIsWorktree: true, repositories: [{ repositoryPath: nested }] })
      expect(run.codebase?.name).toBeNull()
      expect(events.some((event) => event.type === 'session_codebase')).toBe(false)
      expect(await codebasesRootedAt(outer)).toEqual([])
    } finally {
      runtime.shutdown()
    }
  }, LONG)

  test('a worktree session of one repository with no repository inside it gets one worktree in the repository', async () => {
    const alone = repository(join(place(), 'alone'))
    const { run, runtime } = await start(input(alone, { worktreeBaseBranch: 'main' }), 'one-worktree')
    try {
      expect(isTaskFolderPath(run.cwd)).toBe(false)
      expect(run.cwd).toContain(join('.git', 'solus', 'worktrees'))
      expect(run.codebase).toBeUndefined()
    } finally {
      runtime.shutdown()
    }
  }, LONG)
})
