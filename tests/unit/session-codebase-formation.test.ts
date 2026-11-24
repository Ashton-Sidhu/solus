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

// docs/plans/codebases.md decision 13: a codebase forms by itself. A person
// does no manual step before a session can work in more than one folder, and a
// person's "no" (a deleted codebase, "No codebase") is kept. Each rule here
// reads real folders and real repositories, because the disk decides.

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

function runtimeFor(sessionId: string): Watched {
  const runtime = new runtimeModule.SessionRuntime(new Map())
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

describe('rule 1: a session with no codebase takes the one codebase that holds its project folder', () => {
  test('the session takes it, and its folders are the members in the same turn', async () => {
    // WHY: an agent-started session, an automation, and a mobile session name no codebase. They must get the one of the folder.
    const { shop: folder, api, web } = shop()
    const codebase = await saved('one-holder', [folder])
    const { runtime, taken, events } = runtimeFor('takes-one')
    try {
      const folders = await runtime.sessionFolders.resolve('takes-one', { workingDirectory: api, repositoryRoot: api, actor: HOST_ACTOR })
      expect(pathsOf(folders)).toEqual([folder, web])
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
    await saved('first-holder', [folder])
    await saved('second-holder', [folder])
    const { runtime, taken } = runtimeFor('two-holders')
    try {
      expect(await runtime.sessionFolders.resolve('two-holders', { workingDirectory: folder, actor: HOST_ACTOR })).toEqual([])
      expect(await runtime.sessionFolders.codebaseIdOf('two-holders')).toBeNull()
      expect(taken).toEqual([])
      expect(await codebases.codebasesOfFolder(ANY_ORGANIZATION, installationId, folder)).toHaveLength(2)
    } finally {
      runtime.shutdown()
    }
  })
})

describe('rule 2: a folder that holds a repository forms a codebase', () => {
  test('a folder with two repositories forms a codebase with one root, and the session has both repositories in the same turn', async () => {
    const { shop: folder, api, web } = shop()
    await records.upsertOwnSessionRecord({ sessionId: 'forms-shop', provider: 'codex', projectPath: '-shop', lastActivityAt: 1_000 })
    const { runtime, taken, events } = runtimeFor('forms-shop')
    try {
      const folders = await runtime.sessionFolders.resolve('forms-shop', { workingDirectory: folder, actor: HOST_ACTOR })

      const [formed] = await codebasesRootedAt(folder)
      expect(formed).toMatchObject({ name: 'shop', roots: [{ installationId, path: folder, name: '' }], deletedAt: null })
      expect(folders.map(({ path, source }) => ({ path, source }))).toEqual([{ path: api, source: 'codebase' }, { path: web, source: 'codebase' }])
      // The agent is told about the codebase in the turn that made it.
      expect(runtime.sessionFolders.promptFolders('forms-shop')).toMatchObject({ name: 'shop', folders: [{ path: api }, { path: web }] })
      // The record of the session keeps the codebase, so a restart of the host forms no second one.
      expect((await records.storedSessionFolders('forms-shop'))?.codebaseId).toBe(formed!.id)

      // The run of each client gets the codebase one time.
      expect(taken).toEqual([{ type: 'session_codebase', codebaseId: formed!.id, name: 'shop' }])
      // The conversation gets one divider. Its author is the actor of the turn, who is the creator of the codebase: the host here.
      expect(dividersIn(events)).toMatchObject([{
        kind: 'codebase_formed', codebaseId: formed!.id, name: 'shop', folders: ['shop'],
        subject: { kind: 'session', id: 'forms-shop' }, by: { kind: 'system' },
      }])
      await runtime.sessionFolders.resolve('forms-shop', { workingDirectory: folder, actor: HOST_ACTOR })
      expect(taken).toHaveLength(1)
      expect(dividersIn(events)).toHaveLength(1)
      expect(await codebasesRootedAt(folder)).toHaveLength(1)
    } finally {
      runtime.shutdown()
    }
  })

  test('the divider is in the history that a reload and a second client read, at the place where the codebase formed', async () => {
    // WHY: a toast was gone after a reload. The divider is a stored activity, as a move into a worktree is,
    // so each reader gets the same line at the same place.
    const { shop: folder } = shop()
    const { runtime, events } = runtimeFor('reloads')
    try {
      await runtime.sessionFolders.resolve('reloads', { workingDirectory: folder, actor: HOST_ACTOR })
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
    const { shop: folder } = shop()
    const runtime = new runtimeModule.SessionRuntime(new Map())
    const { sent, until } = publishesOf(runtime)
    try {
      await runtime.sessionFolders.resolve('replayed', { workingDirectory: folder, actor: HOST_ACTOR })
      const [formed] = await codebasesRootedAt(folder)
      sent.length = 0
      runtime.sessionFolders.replayTo('replayed', 'client-2')
      // The folders go at once: a `git_context` that names one of them can come next.
      expect(sent.map(({ event }) => event.type)).toEqual(['session_folders'])
      // The codebase goes after a read of its record.
      await until(() => sent.length === 2)
      expect(sent[1]).toEqual({ event: { type: 'session_codebase', codebaseId: formed!.id, name: formed!.name }, only: 'client-2' })
      expect(await activityRecord.activityFor(ANY_ORGANIZATION, { kind: 'session', id: 'replayed' })).toHaveLength(1)
    } finally {
      runtime.shutdown()
    }
  })

  test('a client that starts to watch after the delete does not get the deleted codebase', async () => {
    // WHY: a person deletes the codebase, and the session keeps its copy until the next turn start.
    // A client that connects before that turn must not show a codebase that does not exist.
    // The folders have names of their own: a deleted "shop" would change the numbers that a different test reads.
    const undone = join(place(), 'undone')
    repository(join(undone, 'api'))
    const kept = join(place(), 'kept')
    repository(join(kept, 'api'))
    const runtime = new runtimeModule.SessionRuntime(new Map())
    const { sent, until } = publishesOf(runtime)
    const typesSentTo = (clientId: string) => sent.filter(({ only }) => only === clientId).map(({ event }) => event.type)
    try {
      await runtime.sessionFolders.resolve('undone', { workingDirectory: undone, actor: HOST_ACTOR })
      await runtime.sessionFolders.resolve('kept', { workingDirectory: kept, actor: HOST_ACTOR })
      const [formed] = await codebasesRootedAt(undone)
      // The delete: the client saves the record with `deletedAt`.
      await codebases.saveCodebase('local', 'owner', { ...formed!, updatedAt: formed!.updatedAt + 1, deletedAt: formed!.updatedAt + 1 })
      runtime.sessionFolders.replayTo('undone', 'client-2')
      // The replay of a session whose codebase exists starts later, so its codebase arrives after the first replay sent all that it sends.
      runtime.sessionFolders.replayTo('kept', 'client-3')
      await until(() => typesSentTo('client-3').includes('session_codebase'))
      expect(typesSentTo('client-2')).toEqual(['session_folders'])
    } finally {
      runtime.shutdown()
    }
  })

  test('a folder with no repository inside it forms nothing', async () => {
    const folder = join(place(), 'notes')
    mkdirSync(join(folder, 'drafts'), { recursive: true })
    const alone = repository(join(place(), 'alone'))
    const { runtime, taken } = runtimeFor('nothing-inside')
    try {
      expect(await runtime.sessionFolders.resolve('nothing-inside', { workingDirectory: folder, actor: HOST_ACTOR })).toEqual([])
      // A repository with no repository inside it is one folder: it needs no codebase.
      expect(await runtime.sessionFolders.resolve('nothing-inside', { workingDirectory: alone, repositoryRoot: alone, actor: HOST_ACTOR })).toEqual([])
      expect(taken).toEqual([])
      expect(await codebasesRootedAt(folder)).toEqual([])
      expect(await codebasesRootedAt(alone)).toEqual([])
      expect(runtime.sessionFolders.promptFolders('nothing-inside')).toBeUndefined()
    } finally {
      runtime.shutdown()
    }
  })

  test('a repository that holds a nested repository forms a codebase whose root is the repository', async () => {
    const outer = repository(join(place(), 'platform'))
    const nested = repository(join(outer, 'services', 'billing'))
    const { runtime } = runtimeFor('nested')
    try {
      // The session works in a subfolder: its project folder is the root of the repository.
      const folders = await runtime.sessionFolders.resolve('nested', { workingDirectory: join(outer, 'services'), repositoryRoot: outer, actor: HOST_ACTOR })
      const [formed] = await codebasesRootedAt(outer)
      expect(formed).toMatchObject({ name: 'platform', roots: [{ path: outer }] })
      expect(pathsOf(folders)).toEqual([nested])
    } finally {
      runtime.shutdown()
    }
  })

  test('a session in a worktree forms the codebase of the original folder, never of the worktree', async () => {
    const outer = repository(join(place(), 'platform'))
    repository(join(outer, 'services', 'billing'))
    const worktree = join(outer, '.git', 'solus', 'worktrees', 'fix')
    git(outer, 'worktree', 'add', '-q', '-b', 'fix', worktree)
    const { runtime } = runtimeFor('in-worktree')
    try {
      await runtime.sessionFolders.resolve('in-worktree', { workingDirectory: worktree, repositoryRoot: outer, actor: HOST_ACTOR })
      expect(await codebasesRootedAt(outer)).toHaveLength(1)
      expect(await codebasesRootedAt(worktree)).toEqual([])
    } finally {
      runtime.shutdown()
    }
  })
})

describe('rule 4: an attach in a session with no codebase forms a codebase', () => {
  test('a folder that is attached on purpose forms a codebase with two roots', async () => {
    // WHY: a session in `~/solus` that is told to change `~/solus-cloud`. The next session there must start with both.
    const home = place()
    const solus = repository(join(home, 'solus'))
    const cloud = repository(join(home, 'solus-cloud'))
    const { runtime, taken, events } = runtimeFor('attaches')
    try {
      await runtime.sessionFolders.resolve('attaches', { workingDirectory: solus, repositoryRoot: solus, actor: HOST_ACTOR })
      expect(taken).toEqual([])
      const folders = await runtime.sessionFolders.attach('attaches', cloud, 'attached', HOST_ACTOR)

      const [formed] = await codebasesRootedAt(solus)
      expect(formed).toMatchObject({ name: 'solus', roots: [{ installationId, path: solus, name: '' }, { installationId, path: cloud, name: '' }] })
      expect(taken).toEqual([{ type: 'session_codebase', codebaseId: formed!.id, name: 'solus' }])
      // The divider names the two folders that the codebase was made from, the project folder first.
      expect(dividersIn(events)).toMatchObject([{ codebaseId: formed!.id, name: 'solus', folders: ['solus', 'solus-cloud'] }])
      // The attached folder is a member of the codebase now.
      expect(folders).toEqual([{ path: cloud, name: 'solus-cloud', state: 'git', repositoryPath: cloud, source: 'codebase', granted: true }])

      // The next session in the folder starts with both folders, with no manual step.
      const next = runtimeFor('next-session')
      try {
        expect(pathsOf(await next.runtime.sessionFolders.resolve('next-session', { workingDirectory: solus, repositoryRoot: solus, actor: HOST_ACTOR }))).toEqual([cloud])
        expect(next.taken).toEqual([{ type: 'session_codebase', codebaseId: formed!.id, name: 'solus' }])
        // The next session takes the codebase that exists: it gets no divider.
        expect(dividersIn(next.events)).toEqual([])
      } finally {
        next.runtime.shutdown()
      }
    } finally {
      runtime.shutdown()
    }
  })

  test('a folder that Solus only saw a write in forms a codebase only when it is a listed project', async () => {
    const home = place()
    const work = repository(join(home, 'work'))
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
      expect(dividersIn(events)).toMatchObject([{ codebaseId: formed!.id, folders: ['work', 'listed'] }])
    } finally {
      runtime.shutdown()
    }
  })

  test('an attach in a session that has a codebase adds no root', async () => {
    const { shop: folder, api } = shop()
    const other = repository(join(place(), 'other'))
    const codebase = await saved('kept-roots', [folder])
    const { runtime, taken } = runtimeFor('has-codebase')
    try {
      await runtime.sessionFolders.resolve('has-codebase', { workingDirectory: api, repositoryRoot: api, codebaseId: codebase.id, actor: HOST_ACTOR })
      const folders = await runtime.sessionFolders.attach('has-codebase', other, 'attached', HOST_ACTOR)
      // The folder is for this session only: its row offers "Add to codebase".
      expect(folders.find((each) => each.path === other)?.source).toBe('attached')
      expect((await codebases.getCodebase(ANY_ORGANIZATION, codebase.id))?.roots.map((each) => each.path)).toEqual([folder])
      expect(await codebasesRootedAt(other)).toEqual([])
      expect(taken).toEqual([])
    } finally {
      runtime.shutdown()
    }
  })

  test('a folder that a project tool made forms a codebase with it, unless the caller keeps it out', async () => {
    // WHY: `create_project` and `clone_project` make the second folder of the work. `add_to_codebase: false` says that it is not.
    const home = place()
    const work = repository(join(home, 'work'))
    const kept = repository(join(home, 'kept-out'))
    const made = repository(join(home, 'made'))
    const { runtime, taken } = runtimeFor('creates')
    try {
      await runtime.sessionFolders.resolve('creates', { workingDirectory: work, repositoryRoot: work, actor: HOST_ACTOR })
      expect(await runtime.sessionFolders.adoptCreated('creates', kept, false, HOST_ACTOR)).toEqual({ addedToCodebase: false })
      expect(await codebasesRootedAt(work)).toEqual([])
      expect(taken).toEqual([])

      expect(await runtime.sessionFolders.adoptCreated('creates', made, true, HOST_ACTOR)).toEqual({ addedToCodebase: true })
      expect((await codebasesRootedAt(work))[0]?.roots.map((each) => each.path)).toEqual([work, made])
      // The folder that the caller kept out stays a folder of this session only.
      expect(runtime.sessionFolders.foldersOf('creates').map(({ path, source }) => ({ path, source }))).toEqual([
        { path: kept, source: 'created' },
        { path: made, source: 'codebase' },
      ])
    } finally {
      runtime.shutdown()
    }
  })

  test('a folder attached before the first turn forms the codebase at that turn start, when the choice of the person is known', async () => {
    // WHY: the prompt trigger attaches before the launch. A draft with "No codebase" must stay with none.
    const home = place()
    const work = repository(join(home, 'work'))
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
      expect(dividersIn(accepts.events)).toMatchObject([{ folders: ['work', 'named'] }])
      expect(dividersIn(refuses.events)).toEqual([])
    } finally {
      refuses.runtime.shutdown()
      accepts.runtime.shutdown()
    }
  })
})

describe('the name, the lock, and a person\'s "no"', () => {
  test('a name that a live codebase has gets a number', async () => {
    const first = shop()
    const second = shop()
    const third = shop()
    const { runtime, taken } = runtimeFor('names')
    try {
      // `shop` is taken by the tests above: each new one gets the next free number.
      const namesBefore = new Set((await codebases.listCodebases(ANY_ORGANIZATION)).map((codebase) => codebase.name))
      for (const each of [first, second, third]) {
        const { runtime: one, taken: events } = runtimeFor('names')
        try {
          await one.sessionFolders.resolve('names', { workingDirectory: each.shop, actor: HOST_ACTOR })
          taken.push(...events)
        } finally {
          one.shutdown()
        }
      }
      const names = taken.map((event) => event.name)
      expect(new Set(names).size).toBe(3)
      for (const name of names) {
        expect(name).toMatch(/^shop( \d+)?$/)
        expect(namesBefore.has(name)).toBe(false)
      }
      // The numbers are the next free ones, in order.
      const numbers = names.map((name) => Number(name.slice('shop '.length)) || 1)
      expect(numbers[1]).toBe(numbers[0]! + 1)
      expect(numbers[2]).toBe(numbers[1]! + 1)
    } finally {
      runtime.shutdown()
    }
  })

  test('two sessions that start in one folder at the same moment give one codebase', async () => {
    const { shop: folder } = shop()
    const first = runtimeFor('same-moment-1')
    const second = runtimeFor('same-moment-2')
    try {
      await Promise.all([
        first.runtime.sessionFolders.resolve('same-moment-1', { workingDirectory: folder, actor: HOST_ACTOR }),
        second.runtime.sessionFolders.resolve('same-moment-2', { workingDirectory: folder, actor: HOST_ACTOR }),
      ])
      const formed = await codebasesRootedAt(folder)
      expect(formed).toHaveLength(1)
      const events = [...first.taken, ...second.taken]
      expect(events.map((event) => event.codebaseId)).toEqual([formed[0]!.id, formed[0]!.id])
      // One session made it, and its conversation has the divider. The other one took it.
      expect([dividersIn(first.events).length, dividersIn(second.events).length].sort()).toEqual([0, 1])
    } finally {
      first.runtime.shutdown()
      second.runtime.shutdown()
    }
  })

  test('a deleted codebase that has the folder as a root stops rules 2 and 4, and not rule 1', async () => {
    // WHY: a person deletes the codebase that the host made. The host must not make it again at the next turn.
    const { shop: folder, api } = shop()
    const other = repository(join(place(), 'other'))
    const { runtime, taken } = runtimeFor('undone')
    try {
      await runtime.sessionFolders.resolve('undone', { workingDirectory: folder, actor: HOST_ACTOR })
      const [formed] = await codebasesRootedAt(folder)
      await codebases.saveCodebase('local', 'owner', { ...formed!, updatedAt: formed!.updatedAt + 1, deletedAt: Date.now() })

      // The session whose codebase was deleted is a session with no codebase: rule 2 forms nothing.
      expect(await runtime.sessionFolders.resolve('undone', { workingDirectory: folder, actor: HOST_ACTOR })).toEqual([])
      expect(await codebasesRootedAt(folder)).toEqual([])
      // Rule 4 forms nothing: the attach is for the session only.
      const folders = await runtime.sessionFolders.attach('undone', other, 'attached', HOST_ACTOR)
      expect(folders.map(({ path, source }) => ({ path, source }))).toEqual([{ path: other, source: 'attached' }])
      expect(await codebasesRootedAt(folder)).toEqual([])
      expect(taken).toHaveLength(1)

      // A codebase that a person makes by hand is taken: rule 1 does not read the deleted one.
      const byHand = await saved('made-by-hand', [folder])
      await runtime.sessionFolders.resolve('undone', { workingDirectory: folder, actor: HOST_ACTOR })
      expect(await runtime.sessionFolders.codebaseIdOf('undone')).toBe(byHand.id)
      expect(taken.at(-1)).toEqual({ type: 'session_codebase', codebaseId: byHand.id, name: 'made-by-hand' })
      expect(pathsOf(runtime.sessionFolders.foldersOf('undone'))).toContain(api)
    } finally {
      runtime.shutdown()
    }
  })

  test('a session that started with "No codebase" keeps none', async () => {
    const { shop: folder } = shop()
    const other = repository(join(place(), 'other'))
    const held = shop()
    await saved('held-by-one', [held.shop])
    const { runtime, taken } = runtimeFor('no-codebase')
    try {
      expect(await runtime.sessionFolders.resolve('no-codebase', { workingDirectory: folder, noCodebase: true, actor: HOST_ACTOR })).toEqual([])
      // A later turn that does not say it again changes nothing: the choice is kept for the session.
      await runtime.sessionFolders.resolve('no-codebase', { workingDirectory: folder, actor: HOST_ACTOR })
      await runtime.sessionFolders.attach('no-codebase', other, 'attached', HOST_ACTOR)
      // Rule 1 also gives none.
      await runtime.sessionFolders.resolve('no-codebase', { workingDirectory: held.shop, actor: HOST_ACTOR })
      expect(taken).toEqual([])
      expect(await codebasesRootedAt(folder)).toEqual([])
      expect(await runtime.sessionFolders.codebaseIdOf('no-codebase')).toBeNull()

      // The person chooses a codebase: the session takes it.
      const chosen = await saved('chosen-later', [folder])
      await runtime.sessionFolders.resolve('no-codebase', { workingDirectory: folder, codebaseId: chosen.id, actor: HOST_ACTOR })
      expect(await runtime.sessionFolders.codebaseIdOf('no-codebase')).toBe(chosen.id)
    } finally {
      runtime.shutdown()
    }
  })

  test('a chat, the home directory, the projects root, and a guest form nothing', async () => {
    // The home directory of the person who runs the test: the rule stops before it reads the folder, and nothing is written there.
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
        await runtime.sessionFolders.resolve('special', { workingDirectory, actor: HOST_ACTOR })
        expect(await codebasesRootedAt(workingDirectory)).toEqual([])
      }
      await runtime.sessionFolders.resolve('special', { workingDirectory: folder, actor: { principal: guest, user: null } })
      expect(await codebasesRootedAt(folder)).toEqual([])
      expect(taken).toEqual([])
    } finally {
      runtime.shutdown()
      restoreEnv('SOLUS_PROJECTS_ROOT', previousEnv.projectsRoot)
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

  test('the first turn in a folder with repositories gets the codebase block', async () => {
    const { shop: folder, api, web } = shop()
    const { run, events, runtime } = await start(input(folder), 'first-turn')
    try {
      expect(run.codebase).toMatchObject({
        workingDirectory: { name: 'shop', path: folder, state: 'plain' },
        folders: [{ name: 'api', path: api, state: 'git' }, { name: 'web', path: web, state: 'git' }],
      })
      expect(run.codebase?.name).toMatch(/^shop( \d+)?$/)
      expect(events.filter((event) => event.type === 'session_codebase')).toHaveLength(1)
      // The first prompt of the session made the codebase: the conversation says so one time.
      expect(dividersIn(events)).toMatchObject([{ folders: ['shop'] }])
    } finally {
      runtime.shutdown()
    }
  }, LONG)

  test('the first worktree session in a folder with repositories gets a task folder with each repository', async () => {
    // WHY: the plan of a new worktree reads the codebase of the session. The codebase must exist before the plan.
    const { shop: folder, api, web } = shop()
    const { run, runtime } = await start(input(folder, { worktreeBaseBranch: 'main' }), 'first-worktree')
    try {
      expect(isTaskFolderPath(run.cwd)).toBe(true)
      const taskFolder = store.findTaskFolderContaining(run.cwd)!
      expect(taskFolder).toMatchObject({ primaryRepositoryPath: folder, primaryIsWorktree: false })
      expect(taskFolder.repositories.map((each) => each.repositoryPath).sort()).toEqual([api, web])
      expect(pathsOf(runtime.sessionFolders.foldersOf('first-worktree'))).toEqual([join(run.cwd, 'api'), join(run.cwd, 'web')])
    } finally {
      runtime.shutdown()
    }
  }, LONG)

  test('a session that started with "No codebase" gets one worktree and no block', async () => {
    const outer = repository(join(place(), 'platform'))
    repository(join(outer, 'services', 'billing'))
    const { run, events, runtime } = await start(input(outer, { worktreeBaseBranch: 'main', noCodebase: true }), 'no-codebase-worktree')
    try {
      expect(isTaskFolderPath(run.cwd)).toBe(false)
      expect(run.codebase).toBeUndefined()
      expect(events.some((event) => event.type === 'session_codebase')).toBe(false)
      expect(await codebasesRootedAt(outer)).toEqual([])
    } finally {
      runtime.shutdown()
    }
  }, LONG)
})
