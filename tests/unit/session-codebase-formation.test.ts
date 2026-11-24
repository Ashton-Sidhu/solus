import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { isTaskFolderPath, plainCodebaseName, validGeneratedCodebaseName, type Codebase } from '@solus/contracts/codebases'
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

/**
 * The model that names a codebase. `answer` is what it submits with its tool
 * (null: it submits nothing), and `release` lets its answer arrive. Each
 * prompt that it got is kept, so a test can read what the model was told.
 */
const nameModel = {
  answer: null as string | null,
  prompts: [] as string[],
  gate: Promise.resolve(),
}
mock.module('@solus/server/execution/agents/writing-backend', () => ({
  writingBackendFor: async () => ({ provider: 'claude-code', model: 'claude-haiku-5-5', organizationId: 'local' }),
}))
mock.module('@solus/server/execution/agents/text-generator', () => ({
  TextGenerator: class {
    async generate(options: { prompt: string; tools?: { name: string; execute(input: { name: string }, context: never): Promise<unknown> }[] }): Promise<string> {
      const tool = options.tools?.find((each) => each.name === 'submit_codebase_name')
      if (!tool) return ''
      nameModel.prompts.push(options.prompt)
      await nameModel.gate
      if (nameModel.answer !== null) await tool.execute({ name: nameModel.answer }, undefined as never)
      return ''
    }
  },
}))
actAsHostForTests()

// docs/plans/codebases.md decisions 13 and 14. A project is one folder or one
// repository. A folder that is no repository and holds two or more
// repositories is a container, and a container is a codebase. The host also
// makes a codebase when a real second project is attached to a session. A
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
let formation: typeof import('@solus/server/execution/sessions/session-codebase-formation')
let naming: typeof import('@solus/server/execution/sessions/codebase-name')
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
  formation = await import('@solus/server/execution/sessions/session-codebase-formation')
  naming = await import('@solus/server/execution/sessions/codebase-name')
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

/** `<place>/<name>`, a container: a folder with no repository that holds the repositories `api` and `web`. */
function shop(name = 'shop'): { shop: string; api: string; web: string } {
  const folder = join(place(), name)
  return { shop: folder, api: repository(join(folder, 'api')), web: repository(join(folder, 'web')) }
}

/** A codebase that a person made. `containers` are the roots that have the container mark. */
function saved(id: string, paths: string[], fields: Partial<Codebase> = {}, containers: string[] = []): Promise<Codebase> {
  return codebases.saveCodebase('local', 'owner', {
    id, name: id, updatedAt: 1_000, deletedAt: null,
    roots: paths.map((path) => ({ installationId, path, name: '', ...(containers.includes(path) ? { container: true as const } : {}) })),
    ...fields,
  })
}

/** Wait until `isMet` answers true. The name of a codebase arrives after its formation. */
async function eventually(isMet: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await isMet()) return
    await new Promise((done) => setTimeout(done, 5))
  }
  throw new Error('The condition was not met.')
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
    const codebase = await saved('one-holder', [folder, ui], {}, [folder])
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

  test('a root with no container mark is one project: the session gets no repository inside it', async () => {
    // WHY: Solus does not look inside a project for more repositories (decision 14).
    const outer = repository(join(place(), 'platform'))
    repository(join(outer, 'services', 'billing'))
    const ui = repository(join(place(), 'ui'))
    await saved('two-projects', [outer, ui])
    const { runtime } = runtimeFor('unmarked-roots')
    try {
      expect(pathsOf(await runtime.sessionFolders.resolve('unmarked-roots', { workingDirectory: outer, repositoryRoot: outer, actor: HOST_ACTOR }))).toEqual([ui])
    } finally {
      runtime.shutdown()
    }
  })
})

describe('a container is a codebase (decision 14)', () => {
  test('a session whose working directory is a container gets the container codebase, with the name of the folder', async () => {
    // WHY: `~/shop` holds `api` and `web`. It is one piece of work with two repositories, so it is a codebase, not a project.
    const { shop: folder, api, web } = shop('storefront')
    await records.upsertOwnSessionRecord({ sessionId: 'in-container', provider: 'codex', projectPath: '-storefront', lastActivityAt: 1_000 })
    const { runtime, taken, events } = runtimeFor('in-container')
    try {
      const folders = await runtime.sessionFolders.resolve('in-container', { workingDirectory: folder, actor: HOST_ACTOR })

      // One root, the container folder, with the mark. The record holds no repository: the disk gives them.
      const [formed] = await codebasesRootedAt(folder)
      expect(formed).toMatchObject({ name: 'storefront', roots: [{ installationId, path: folder, name: '', container: true }] })
      expect(await codebasesRootedAt(folder)).toHaveLength(1)
      // The session works in the container folder, and its repositories are its folders.
      expect(folders).toEqual([
        { path: api, name: 'api', state: 'git', repositoryPath: api, source: 'codebase', granted: true },
        { path: web, name: 'web', state: 'git', repositoryPath: web, source: 'codebase', granted: true },
      ])
      // The repositories are in the working directory: the provider reaches them with no grant.
      expect(runtime.sessionFolders.grantedPaths('in-container')).toEqual([])
      // Each repository gets its own checkpoint.
      expect(pathsOf(runtime.sessionFolders.checkpointTargets('in-container'))).toEqual([api, web])
      expect(runtime.sessionFolders.promptFolders('in-container')).toMatchObject({ name: 'storefront', folders: [{ path: api }, { path: web }], otherHosts: [] })
      expect(taken).toEqual([{ type: 'session_codebase', codebaseId: formed!.id, name: 'storefront' }])
      expect(dividersIn(events)).toMatchObject([{ kind: 'codebase_formed', codebaseId: formed!.id, name: 'storefront' }])
      expect((await records.storedSessionFolders('in-container'))?.codebaseId).toBe(formed!.id)
      // A repository of the container cannot leave the session: it comes from the codebase.
      await expect(runtime.sessionFolders.detach('in-container', api, HOST_ACTOR)).rejects.toThrow(/codebase/)
      // The name of a container is the name of its folder: no model names it.
      expect(nameModel.prompts.some((prompt) => prompt.includes('storefront'))).toBe(false)

      // The next session there takes the codebase that exists, and forms no second one.
      const next = runtimeFor('next-in-container')
      try {
        expect(pathsOf(await next.runtime.sessionFolders.resolve('next-in-container', { workingDirectory: folder, actor: HOST_ACTOR }))).toEqual([api, web])
        expect(await codebasesRootedAt(folder)).toHaveLength(1)
        expect(dividersIn(next.events)).toEqual([])
      } finally {
        next.runtime.shutdown()
      }
    } finally {
      runtime.shutdown()
    }
  })

  test('a repository that is cloned into the container later is a folder of the session at its next turn', async () => {
    const { shop: folder, api, web } = shop()
    const { runtime } = runtimeFor('grows')
    try {
      expect(pathsOf(await runtime.sessionFolders.resolve('grows', { workingDirectory: folder, actor: HOST_ACTOR }))).toEqual([api, web])
      const docs = repository(join(folder, 'docs'))
      expect(pathsOf(await runtime.sessionFolders.resolve('grows', { workingDirectory: folder, actor: HOST_ACTOR }))).toEqual([api, docs, web])
      // The record did not change: it still has the one root.
      expect((await codebasesRootedAt(folder))[0]?.roots).toHaveLength(1)
    } finally {
      runtime.shutdown()
    }
  })

  test('a folder that holds one repository or none is a normal project, and so is a repository that holds repositories', async () => {
    const one = join(place(), 'one')
    repository(join(one, 'api'))
    const notes = join(place(), 'notes')
    mkdirSync(join(notes, 'drafts'), { recursive: true })
    const outer = repository(join(place(), 'platform'))
    repository(join(outer, 'services', 'billing'))
    repository(join(outer, 'services', 'search'))
    const { runtime, taken } = runtimeFor('projects')
    try {
      for (const folder of [one, notes]) {
        expect(await runtime.sessionFolders.resolve('projects', { workingDirectory: folder, actor: HOST_ACTOR })).toEqual([])
        expect(await codebasesRootedAt(folder)).toEqual([])
      }
      // A repository is one project: Solus does not look inside it.
      expect(await runtime.sessionFolders.resolve('projects', { workingDirectory: outer, repositoryRoot: outer, actor: HOST_ACTOR })).toEqual([])
      expect(await codebasesRootedAt(outer)).toEqual([])
      expect(taken).toEqual([])
      expect(runtime.sessionFolders.promptFolders('projects')).toBeUndefined()
    } finally {
      runtime.shutdown()
    }
  })

  test('a session in one repository of a container forms nothing, and takes the codebase of the container when it exists', async () => {
    const { shop: folder, api, web } = shop()
    const { runtime, taken } = runtimeFor('in-api')
    try {
      // `api` is a project. Only a session that works in the container folder makes the codebase.
      expect(await runtime.sessionFolders.resolve('in-api', { workingDirectory: api, repositoryRoot: api, actor: HOST_ACTOR })).toEqual([])
      expect(await codebasesRootedAt(folder)).toEqual([])
      expect(taken).toEqual([])

      await formation.formContainerCodebases(folder, HOST_ACTOR)
      const folders = await runtime.sessionFolders.resolve('in-api', { workingDirectory: api, repositoryRoot: api, actor: HOST_ACTOR })
      expect(pathsOf(folders).sort()).toEqual([folder, web].sort())
    } finally {
      runtime.shutdown()
    }
  })

  test('the codebase forms when a person adds the folder as a project, before a session works there', async () => {
    // WHY: the picker must show the folder under Codebases immediately, not after the first turn.
    const { shop: folder } = shop('added')
    await manifest.recordProject(folder)
    await formation.formContainerCodebases(folder, HOST_ACTOR)
    expect(await codebasesRootedAt(folder)).toMatchObject([{ name: 'added', roots: [{ path: folder, container: true }] }])
    // A second add changes nothing.
    await formation.formContainerCodebases(folder, HOST_ACTOR)
    expect(await codebasesRootedAt(folder)).toHaveLength(1)
  })

  test('a clone into a listed project that then holds two repositories makes that project a container', async () => {
    const folder = join(place(), 'growing')
    repository(join(folder, 'api'))
    await manifest.recordProject(folder)
    await formation.formContainerCodebases(folder, HOST_ACTOR)
    // One repository inside: a normal project.
    expect(await codebasesRootedAt(folder)).toEqual([])

    const web = repository(join(folder, 'web'))
    await formation.formContainerCodebases(web, HOST_ACTOR)
    expect(await codebasesRootedAt(folder)).toMatchObject([{ name: 'growing', roots: [{ path: folder, container: true }] }])
  })

  test('a clone into a folder that the host does not list forms nothing', async () => {
    // WHY: `~/code` holds each repository of a person. It is no piece of work, and nobody added it.
    const folder = join(place(), 'code')
    repository(join(folder, 'one'))
    const two = repository(join(folder, 'two'))
    await formation.formContainerCodebases(two, HOST_ACTOR)
    expect(await codebasesRootedAt(folder)).toEqual([])
  })

  test('a deleted container codebase is not made again', async () => {
    // WHY: a person's "no" is kept. The folder is then in no codebase, and it is listed as a project again.
    const { shop: folder } = shop()
    await formation.formContainerCodebases(folder, HOST_ACTOR)
    const [formed] = await codebasesRootedAt(folder)
    await codebases.saveCodebase('local', 'owner', { ...formed!, updatedAt: formed!.updatedAt + 1, deletedAt: Date.now() })

    await formation.formContainerCodebases(folder, HOST_ACTOR)
    const { runtime, taken } = runtimeFor('after-delete')
    try {
      expect(await runtime.sessionFolders.resolve('after-delete', { workingDirectory: folder, actor: HOST_ACTOR })).toEqual([])
      expect(await codebasesRootedAt(folder)).toEqual([])
      expect(taken).toEqual([])
    } finally {
      runtime.shutdown()
    }
  })

  test('a chat, the home directory, the projects root, and a guest get no codebase', async () => {
    // WHY: these folders hold much more than one piece of work, and a guest stays in the checkout of the shared session.
    // The home directory of the person who runs the test: the rule stops before it makes a record.
    const home = homedir()
    const projects = join(place(), 'projects')
    repository(join(projects, 'api'))
    repository(join(projects, 'web'))
    const chat = join(root, 'data', 'solus-chats', 'chat1')
    repository(join(chat, 'scratch'))
    repository(join(chat, 'second'))
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
        await formation.formContainerCodebases(workingDirectory, HOST_ACTOR)
        expect(await codebasesRootedAt(workingDirectory)).toEqual([])
      }
      expect(await runtime.sessionFolders.resolve('special', { workingDirectory: folder, actor: { principal: guest, user: null } })).toEqual([])
      expect(await codebasesRootedAt(folder)).toEqual([])
      expect(taken).toEqual([])
    } finally {
      runtime.shutdown()
      restoreEnv('SOLUS_PROJECTS_ROOT', previousEnv.projectsRoot)
    }
  })
})

describe('rule 2: a second project that is attached in a session with no codebase forms a codebase', () => {
  test('a repository that is attached on purpose forms a codebase with two roots and a plain name', async () => {
    // WHY: a session in `~/solus` that is told to change `~/solus-cloud`. The next session there must start with both.
    const home = place()
    const solus = repository(join(home, 'orbit'))
    const cloud = repository(join(home, 'orbit-cloud'))
    await records.upsertOwnSessionRecord({ sessionId: 'attaches', provider: 'codex', projectPath: '-orbit', lastActivityAt: 1_000 })
    const { runtime, taken, events } = runtimeFor('attaches')
    try {
      await runtime.sessionFolders.resolve('attaches', { workingDirectory: solus, repositoryRoot: solus, actor: HOST_ACTOR })
      expect(taken).toEqual([])
      const folders = await runtime.sessionFolders.attach('attaches', cloud, 'attached', HOST_ACTOR)

      // The plain name: the common start of the two folder names. Each root is one project: no container mark.
      const [formed] = await codebasesRootedAt(solus)
      expect(formed).toMatchObject({ name: 'orbit', roots: [{ installationId, path: solus, name: '' }, { installationId, path: cloud, name: '' }] })
      expect(formed!.roots.some((each) => each.container)).toBe(false)
      expect(taken).toEqual([{ type: 'session_codebase', codebaseId: formed!.id, name: 'orbit' }])
      // The divider records the codebase and its name at that time.
      // Its author is the actor of the attach, who is the creator of the codebase: the host here.
      expect(dividersIn(events)).toMatchObject([{
        kind: 'codebase_formed', codebaseId: formed!.id, name: 'orbit',
        subject: { kind: 'session', id: 'attaches' }, by: { kind: 'system' },
      }])
      // The attached folder is a member of the codebase now.
      expect(folders).toEqual([{ path: cloud, name: 'orbit-cloud', state: 'git', repositoryPath: cloud, source: 'codebase', granted: true }])
      // The agent is told about the codebase.
      expect(runtime.sessionFolders.promptFolders('attaches')).toMatchObject({ name: 'orbit', folders: [{ path: cloud }] })
      // The record of the session keeps the codebase, so a restart of the host forms no second one.
      expect((await records.storedSessionFolders('attaches'))?.codebaseId).toBe(formed!.id)

      // The next session in the folder starts with both folders, with no manual step.
      const next = runtimeFor('next-session')
      try {
        expect(pathsOf(await next.runtime.sessionFolders.resolve('next-session', { workingDirectory: solus, repositoryRoot: solus, actor: HOST_ACTOR }))).toEqual([cloud])
        expect(next.taken).toEqual([{ type: 'session_codebase', codebaseId: formed!.id, name: 'orbit' }])
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
    // WHY: a folder inside the project is a part of that project, so it is no second project.
    // A codebase of a folder and a folder inside it has one root too many.
    const home = place()
    const parent = repository(join(home, 'mono'))
    const project = repository(join(parent, 'apps', 'site'))
    const deep = repository(join(project, 'a', 'b', 'c'))
    await manifest.recordProject(parent)
    const { runtime, taken } = runtimeFor('attaches-inside')
    try {
      await runtime.sessionFolders.resolve('attaches-inside', { workingDirectory: project, repositoryRoot: project, actor: HOST_ACTOR })
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
      // The two names have no common start: the first name and a count.
      expect(taken).toMatchObject([{ codebaseId: formed!.id, name: 'work +1' }])
    } finally {
      runtime.shutdown()
    }
  })

  test('a second project that is a container is a root with the container mark', async () => {
    // WHY: the host reads the repositories of a container root. Without the mark, the session gets the folder only.
    const work = repository(join(place(), 'client'))
    const { shop: backend, api, web } = shop('backend')
    await manifest.recordProject(backend)
    const { runtime } = runtimeFor('attaches-container')
    try {
      await runtime.sessionFolders.resolve('attaches-container', { workingDirectory: work, repositoryRoot: work, actor: HOST_ACTOR })
      const folders = await runtime.sessionFolders.attach('attaches-container', backend, 'attached', HOST_ACTOR)
      expect((await codebasesRootedAt(work))[0]?.roots).toMatchObject([{ path: work }, { path: backend, container: true }])
      expect(pathsOf(folders)).toEqual([backend, api, web])
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
      expect(dividersIn(events)).toMatchObject([{ codebaseId: formed!.id }])
    } finally {
      runtime.shutdown()
    }
  })

  test('an attach in a session that has a codebase adds no root', async () => {
    const { shop: folder, api } = shop()
    const ui = repository(join(place(), 'ui'))
    const other = repository(join(place(), 'other'))
    const codebase = await saved('kept-roots', [folder, ui], {}, [folder])
    const { runtime, taken } = runtimeFor('has-codebase')
    try {
      await runtime.sessionFolders.resolve('has-codebase', { workingDirectory: api, repositoryRoot: api, codebaseId: codebase.id, actor: HOST_ACTOR })
      const folders = await runtime.sessionFolders.attach('has-codebase', other, 'attached', HOST_ACTOR)
      // The folder is for this session only: its menu offers "Add to codebase".
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
      expect((await codebasesRootedAt(work))[0]).toMatchObject({ name: 'tooled +1', roots: [{ path: work }, { path: made }] })
      // The folder that the caller kept out stays a folder of this session only.
      expect(runtime.sessionFolders.foldersOf('creates').map(({ path, source }) => ({ path, source }))).toEqual([
        { path: kept, source: 'created' },
        { path: made, source: 'codebase' },
      ])
    } finally {
      runtime.shutdown()
    }
  })

  test('a second repository that a tool made in the project folder makes that folder a container at the next turn', async () => {
    const work = join(place(), 'workspace')
    const api = repository(join(work, 'api'))
    const { runtime, taken } = runtimeFor('creates-inside')
    try {
      // One repository inside: a normal project, with no folder besides the working directory.
      expect(await runtime.sessionFolders.resolve('creates-inside', { workingDirectory: work, actor: HOST_ACTOR })).toEqual([])
      const made = repository(join(work, 'web'))
      // The new folder is in the working directory: the session reaches it, and no codebase of two roots is made.
      expect(await runtime.sessionFolders.adoptCreated('creates-inside', made, true, HOST_ACTOR)).toEqual({ addedToCodebase: false })
      expect(taken).toEqual([])

      expect(pathsOf(await runtime.sessionFolders.resolve('creates-inside', { workingDirectory: work, actor: HOST_ACTOR }))).toEqual([api, made])
      expect(await codebasesRootedAt(work)).toMatchObject([{ name: 'workspace', roots: [{ path: work, container: true }] }])
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
      expect(dividersIn(accepts.events)).toHaveLength(1)
      expect(dividersIn(refuses.events)).toEqual([])
    } finally {
      refuses.runtime.shutdown()
      accepts.runtime.shutdown()
    }
  })
})

describe('the name of a codebase that Solus forms from separate projects', () => {
  test('the plain name is the common start of the folder names, else the first name and a count', () => {
    expect(plainCodebaseName(['solus', 'solus-cloud'])).toBe('solus')
    expect(plainCodebaseName(['Shop-API', 'shop-web'])).toBe('Shop')
    expect(plainCodebaseName(['app', 'apple', 'application'])).toBe('app')
    // A common start of fewer than three characters names nothing.
    expect(plainCodebaseName(['ab-api', 'ab-web'])).toBe('ab-api +1')
    expect(plainCodebaseName(['api', 'web'])).toBe('api +1')
    expect(plainCodebaseName(['api', 'web', 'docs'])).toBe('api +2')
  })

  test('a generated name is one to three words with no punctuation, at most 32 characters', () => {
    expect(validGeneratedCodebaseName('Solus Platform')).toBe('Solus Platform')
    expect(validGeneratedCodebaseName('  Shop  ')).toBe('Shop')
    expect(validGeneratedCodebaseName('One Two Three')).toBe('One Two Three')
    expect(validGeneratedCodebaseName('One Two Three Four')).toBeNull()
    expect(validGeneratedCodebaseName('Solus, Platform')).toBeNull()
    expect(validGeneratedCodebaseName('"Solus"')).toBeNull()
    expect(validGeneratedCodebaseName('solus-cloud')).toBeNull()
    expect(validGeneratedCodebaseName('A'.repeat(33))).toBeNull()
    expect(validGeneratedCodebaseName('')).toBeNull()
  })

  test('the codebase forms at once with its plain name, and the generated name replaces it when it arrives', async () => {
    // WHY: the formation never waits for a model. The session, the agent, and the picker get the codebase immediately.
    let release = (): void => {}
    nameModel.gate = new Promise<void>((done) => { release = done })
    nameModel.answer = 'Comet Platform'
    const { runtime, taken, events } = runtimeFor('named-later')
    try {
      const { formed } = await sessionWithSecondProject(runtime, 'named-later', ['comet', 'comet-cloud'])
      expect(formed.name).toBe('comet')
      expect(taken).toEqual([{ type: 'session_codebase', codebaseId: formed.id, name: 'comet' }])
      // The model reads the names of the folders and the first lines of each README.
      await eventually(() => nameModel.prompts.some((prompt) => prompt.includes('- comet: readme') && prompt.includes('- comet-cloud: readme')))

      release()
      await eventually(() => taken.length === 2)
      // A normal save with a later time, so each host takes the name.
      const renamed = await codebases.getCodebase(ANY_ORGANIZATION, formed.id)
      expect(renamed).toMatchObject({ name: 'Comet Platform', roots: formed.roots })
      expect(renamed!.updatedAt).toBeGreaterThan(formed.updatedAt)
      expect(taken[1]).toEqual({ type: 'session_codebase', codebaseId: formed.id, name: 'Comet Platform' })
      // The name change is no second formation: the conversation keeps its one divider.
      expect(dividersIn(events)).toHaveLength(1)
      expect(runtime.sessionFolders.promptFolders('named-later')).toMatchObject({ name: 'Comet Platform' })
    } finally {
      release()
      nameModel.gate = Promise.resolve()
      nameModel.answer = null
      runtime.shutdown()
    }
  })

  test('an answer that is no correct name keeps the plain name', async () => {
    nameModel.answer = 'The "Best" Codebase, v2!'
    const asked = nameModel.prompts.length
    const { runtime, taken } = runtimeFor('named-badly')
    try {
      const { formed } = await sessionWithSecondProject(runtime, 'named-badly', ['nebula', 'nebula-web'])
      await eventually(() => nameModel.prompts.length > asked)
      // The answer arrived and was refused: give the save that must not come a moment.
      await new Promise((done) => setTimeout(done, 50))
      expect((await codebases.getCodebase(ANY_ORGANIZATION, formed.id))?.name).toBe('nebula')
      expect(taken).toHaveLength(1)
    } finally {
      nameModel.answer = null
      runtime.shutdown()
    }
  })

  test('a generated name does not replace the name that a person gave in that time', async () => {
    let release = (): void => {}
    nameModel.gate = new Promise<void>((done) => { release = done })
    nameModel.answer = 'Pulsar Suite'
    const asked = nameModel.prompts.length
    const { runtime } = runtimeFor('renamed-first')
    try {
      const { formed } = await sessionWithSecondProject(runtime, 'renamed-first', ['pulsar', 'pulsar-docs'])
      await eventually(() => nameModel.prompts.length > asked)
      // The person renames the codebase in Settings while the model works.
      const byPerson = await codebases.saveCodebase('local', 'owner', { ...formed, name: 'My pulsar work', updatedAt: formed.updatedAt + 1 })
      release()
      await new Promise((done) => setTimeout(done, 50))
      expect(await codebases.getCodebase(ANY_ORGANIZATION, formed.id)).toEqual(byPerson)
      // The rule itself: no save when the codebase does not have its plain name, and none for a deleted codebase.
      expect(await formation.renameFormed(formed.id, 'pulsar', 'Pulsar Suite', HOST_ACTOR)).toBeNull()
    } finally {
      release()
      nameModel.gate = Promise.resolve()
      nameModel.answer = null
      runtime.shutdown()
    }
  })

  test('with the naming "from the folder names", no model is asked', async () => {
    // WHY: the setting of the person, or of the project in `.solus/config.json`, which wins.
    nameModel.answer = 'Quasar Tools'
    const home = place()
    const project = repository(join(home, 'quasar'))
    const second = repository(join(home, 'quasar-api'))
    const other = repository(join(home, 'quasar-site'))
    const asked = nameModel.prompts.length
    const byPerson = runtimeFor('named-by-setting')
    try {
      await byPerson.runtime.sessionFolders.resolve('named-by-setting', { workingDirectory: project, repositoryRoot: project, preferences: { codebaseNaming: 'folders' }, actor: HOST_ACTOR })
      await byPerson.runtime.sessionFolders.attach('named-by-setting', second, 'attached', HOST_ACTOR)
      await new Promise((done) => setTimeout(done, 50))
      expect(nameModel.prompts).toHaveLength(asked)
      expect((await codebasesRootedAt(project))[0]?.name).toBe('quasar')

      expect(await naming.resolveCodebaseNaming(other, 'folders')).toBe('folders')
      expect(await naming.resolveCodebaseNaming(other, undefined)).toBe('generated')
      // The project file wins over the setting of the person.
      mkdirSync(join(other, '.solus'))
      writeFileSync(join(other, '.solus', 'config.json'), JSON.stringify({ version: 1, codebaseNaming: 'folders' }))
      expect(await naming.resolveCodebaseNaming(other, 'generated')).toBe('folders')
    } finally {
      nameModel.answer = null
      byPerson.runtime.shutdown()
    }
  })

  test('a name that a person gave on the attach card is used as it is, and no model replaces it', async () => {
    nameModel.answer = 'Meteor Kit'
    const home = place()
    const project = repository(join(home, 'meteor'))
    const second = repository(join(home, 'meteor-ui'))
    const asked = nameModel.prompts.length
    const { runtime, taken } = runtimeFor('named-on-card')
    try {
      await runtime.sessionFolders.resolve('named-on-card', { workingDirectory: project, repositoryRoot: project, actor: HOST_ACTOR })
      await runtime.sessionFolders.attach('named-on-card', second, 'attached', HOST_ACTOR, { codebaseName: 'Meteor stack' })
      await new Promise((done) => setTimeout(done, 50))
      expect((await codebasesRootedAt(project))[0]?.name).toBe('Meteor stack')
      expect(taken).toMatchObject([{ name: 'Meteor stack' }])
      expect(nameModel.prompts).toHaveLength(asked)
    } finally {
      nameModel.answer = null
      runtime.shutdown()
    }
  })
})

describe('the number, the lock, and a person\'s "no"', () => {
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
    expect(names).toEqual(['alpha +1', 'alpha +1 2', 'alpha +1 3'])
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
      expect(dividersIn(withCloud.events)).toHaveLength(1)
    } finally {
      withCloud.runtime.shutdown()
    }
  })

  test('a session that started with "No codebase" keeps none', async () => {
    const { shop: folder } = shop()
    const other = repository(join(place(), 'other'))
    const held = shop()
    await saved('held-by-one', [held.shop, repository(join(place(), 'held-ui'))])
    const { runtime, taken } = runtimeFor('no-codebase')
    try {
      // "No codebase" in a container: the session works in the folder, and no rule gives it the repositories.
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

  test('the first turn in a container gets the block of its codebase, with the name of the folder', async () => {
    const { shop: folder, api, web } = shop('launched')
    const { run, events, runtime } = await start(input(folder), 'first-turn')
    try {
      expect(run.codebase).toEqual({
        name: 'launched',
        workingDirectory: { name: 'launched', path: folder, state: 'plain' },
        folders: [{ name: 'api', path: api, state: 'git' }, { name: 'web', path: web, state: 'git' }],
        otherHosts: [],
      })
      const [formed] = await codebasesRootedAt(folder)
      expect(events.filter((event) => event.type === 'session_codebase')).toEqual([{ type: 'session_codebase', codebaseId: formed!.id, name: 'launched' }])
      expect(dividersIn(events)).toHaveLength(1)
    } finally {
      runtime.shutdown()
    }
  }, LONG)

  test('the first worktree session in a container gets a task folder with a worktree of each repository', async () => {
    // WHY: the host settles the codebase before the plan of the worktree, so the plan reads the repositories of the container.
    const { shop: folder, api, web } = shop()
    const { run, runtime } = await start(input(folder, { worktreeBaseBranch: 'main' }), 'first-worktree')
    try {
      expect(isTaskFolderPath(run.cwd)).toBe(true)
      const taskFolder = store.findTaskFolderContaining(run.cwd)!
      expect(taskFolder).toMatchObject({ primaryRepositoryPath: folder, primaryIsWorktree: false })
      expect(taskFolder.repositories.map((each) => each.repositoryPath).sort()).toEqual([api, web])
      // The worktrees stand in for the repositories of the container.
      expect(runtime.sessionFolders.foldersOf('first-worktree').map(({ path, repositoryPath, source }) => ({ path, repositoryPath, source }))).toEqual([
        { path: join(run.cwd, 'api'), repositoryPath: api, source: 'codebase' },
        { path: join(run.cwd, 'web'), repositoryPath: web, source: 'codebase' },
      ])
      expect(await codebasesRootedAt(folder)).toHaveLength(1)
    } finally {
      runtime.shutdown()
    }
  }, LONG)

  test('a worktree session of a repository that holds a repository gets one worktree: a project is one repository', async () => {
    const outer = repository(join(place(), 'platform'))
    repository(join(outer, 'services', 'billing'))
    const { run, events, runtime } = await start(input(outer, { worktreeBaseBranch: 'main' }), 'nested-worktree')
    try {
      expect(isTaskFolderPath(run.cwd)).toBe(false)
      expect(run.cwd).toContain(join('.git', 'solus', 'worktrees'))
      expect(run.codebase).toBeUndefined()
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
