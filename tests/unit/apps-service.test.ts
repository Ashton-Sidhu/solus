import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appOperationCallName, appStorageCallName } from '@solus/contracts/apps'
import { installTestIdentities } from './helpers/acting-identities'
import { writeAppProject, type AppProjectFiles } from './helpers/app-project'
import { DatabaseSync } from './helpers/bun-sqlite'
import { memberPrincipal, withActor } from './helpers/actors'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'
import { resetTestDatabase } from './helpers/test-db'
import { installTestWorkspaceTools } from './helpers/workspace-tools'

mock.module('node:sqlite', () => ({ DatabaseSync }))

type AppsModule = typeof import('@solus/server/apps/apps')
type Apps = InstanceType<AppsModule['Apps']>
type RunnersModule = typeof import('@solus/server/apps/app-runners')
type SchedulesModule = typeof import('@solus/server/apps/app-schedules')
type WebhooksModule = typeof import('@solus/server/apps/app-webhooks')
type StoreModule = typeof import('@solus/server/data/apps/app-store')
type EventsModule = typeof import('@solus/server/apps/app-events')
type ToolsModule = typeof import('@solus/server/execution/agents/tools/app-tools')

/**
 * The Apps service against a real host: a real database, a real git
 * repository for each app, and a real Node runner. Bun has no permission
 * model, so a machine with no Node 22 or later skips these.
 */
const nodeVersion = spawnSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8' })
const describeWithNode = nodeVersion.status === 0 && Number(nodeVersion.stdout.split('.')[0]) >= 22 ? describe : describe.skip

const NOTES: AppProjectFiles = {
  app: `import { defineApp, query, mutation } from '@solus/app/backend'
import { z } from 'zod'
export default defineApp({
  name: 'Notes',
  description: 'Keeps notes.',
  secrets: { token: { label: 'API token' } },
  integrations: ['linear'],
  operations: {
    list: query({ description: 'Every note.' }, (ctx) => ctx.sql.exec('SELECT id, text FROM notes ORDER BY id').all()),
    add: mutation({ description: 'Save one note.', input: z.object({ text: z.string() }) }, (ctx, input) =>
      ctx.sql.exec('INSERT INTO notes (text) VALUES (?) RETURNING id, text', input.text).one()),
    sneak: query({ description: 'A query that tries to write.' }, (ctx) => ctx.sql.exec("INSERT INTO notes (text) VALUES ('sneaked')").all()),
    whoAndWhat: query({}, (ctx) => ({ caller: ctx.caller, token: ctx.secrets.token ?? null })),
    issues: query({}, (ctx) => ctx.tools.linear.list_issues({ team: 'ENG' })),
  },
  schedules: { tick: { every: { minutes: 5 }, run: 'add', input: { text: 'tick' } } },
  webhooks: { pushed: { verify: { scheme: 'token', source: { kind: 'header', name: 'x-token' } }, run: 'add' } },
})`,
  migrations: { '0001_notes.sql': 'CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL);' },
  ui: '<!doctype html><title>Notes</title><div id="root"></div>',
  source: { 'src/App.tsx': 'export default function App() { return null }\n' },
}

let dataDir: string
let projects: string
let appsModule: AppsModule
let runnersModule: RunnersModule
let schedulesModule: SchedulesModule
let webhooksModule: WebhooksModule
let store: StoreModule
let events: EventsModule
let tools: ToolsModule
let runners: InstanceType<RunnersModule['AppRunners']> | null = null
const previousDataDir = process.env.SOLUS_DATA_DIR

const owner = TEST_HANDLER_CTX
const member = withActor({ clientId: 'member', principal: memberPrincipal('ann', 'Ann', { organizationId: 'local' }) })
const by = { kind: 'system' as const }

const toolCalls: { integrationId: string; tool: string; input: object }[] = []
const gateway = {
  callAppTool: async (integrationId: string, tool: string, input: object) => {
    toolCalls.push({ integrationId, tool, input })
    return { content: [], structuredContent: { issues: ['ENG-1'] } }
  },
  toolsFor: async () => [],
  connectionStatus: async () => ({ status: 'connected' as const }),
}
const integrations = { getBySlug: (slug: string) => (slug === 'linear' ? { id: 'int-linear', name: 'Linear', slug: 'linear', disabledTools: [] } : null) }

beforeAll(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'solus-apps-service-')))
  projects = realpathSync(mkdtempSync(join(tmpdir(), 'solus-apps-projects-')))
  process.env.SOLUS_DATA_DIR = dataDir
  appsModule = await import('@solus/server/apps/apps')
  runnersModule = await import('@solus/server/apps/app-runners')
  schedulesModule = await import('@solus/server/apps/app-schedules')
  webhooksModule = await import('@solus/server/apps/app-webhooks')
  store = await import('@solus/server/data/apps/app-store')
  events = await import('@solus/server/apps/app-events')
  tools = await import('@solus/server/execution/agents/tools/app-tools')
  // The app's git repository is written as the host itself.
  installTestIdentities()
})

afterEach(async () => {
  runners?.dispose()
  runners = null
  tools.useAppsForTools(null)
  toolCalls.length = 0
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
  rmSync(join(dataDir, 'apps'), { recursive: true, force: true })
  rmSync(join(dataDir, 'app-secrets'), { recursive: true, force: true })
})

afterAll(async () => {
  (await import('@solus/server/db')).closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(projects, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

async function service(): Promise<Apps> {
  const [{ AppStorage }, { AppRepositories }] = await Promise.all([import('@solus/server/apps/app-storage'), import('@solus/server/apps/app-repository')])
  runners = new runnersModule.AppRunners({ node: 'node' })
  const apps = new appsModule.Apps({
    // SAFETY: the two fakes answer every member `Apps` names in its dependency types.
    gateway: gateway as never,
    integrations: integrations as never,
    storage: new AppStorage(() => join(dataDir, 'apps', 'data')),
    runners,
    repositories: new AppRepositories(() => join(dataDir, 'apps', 'repositories')),
    runAs: (_personKey, run) => run(),
  })
  tools.useAppsForTools(apps)
  return apps
}

let projectCount = 0
async function project(files: AppProjectFiles): Promise<string> {
  const folder = join(projects, `project-${projectCount++}`)
  await writeAppProject(folder, files)
  return folder
}

const deploy = (apps: Apps, folder: string, app?: string) => apps.deploy(owner, { project: folder, app, createdBy: by, message: 'A change' })
const call = async (apps: Apps, appId: string, name: string, input: object = {}) => JSON.parse(await apps.call(owner, appId, name, JSON.stringify(input))).value

describeWithNode('an app on a host', () => {
  test('a deploy makes the version active, and its operations read and write the app\'s own database', async () => {
    // WHY: this is the whole promise of an app: a deploy makes it run, a
    // mutation writes data that stays, and a query reads it back.
    const apps = await service()
    const changed: string[] = []
    const stop = events.onAppDataChanged((event) => changed.push(event.appId))
    const deployed = await deploy(apps, await project(NOTES))
    expect(deployed).toMatchObject({ version: 1, active: true, created: true, error: null, secretsMissing: ['token'] })
    expect(deployed.app).toMatchObject({ slug: 'notes', name: 'Notes', activeVersion: 1, hasUi: true, operationCount: 5 })
    const id = deployed.app.id

    expect(await call(apps, id, appOperationCallName('add'), { text: 'first' })).toEqual({ id: 1, text: 'first' })
    expect(await call(apps, 'notes', appOperationCallName('list'))).toEqual([{ id: 1, text: 'first' }])
    // Only the mutation changed the data, so only it tells open UIs to read again.
    expect(changed).toEqual([id])
    stop()

    expect(existsSync(join(dataDir, 'apps', 'data', id, 'app.sqlite'))).toBe(true)
    const log = await apps.calls(owner, id)
    expect(log.map((entry) => [entry.operation, entry.outcome, entry.caller.kind])).toEqual([['list', 'ok', 'ui'], ['add', 'ok', 'ui']])
    expect((await apps.ui(owner, id))?.html).toContain('<title>Notes</title>')
  })

  test('a query gets a read-only database, whatever its code does', async () => {
    // WHY: an agent's session treats a query as a read. The descriptor says
    // which operations are queries, and the host holds them to it.
    const apps = await service()
    const { app } = await deploy(apps, await project(NOTES))
    await expect(call(apps, app.id, appOperationCallName('sneak'))).rejects.toThrow(/readonly|read-only/i)
    expect(await call(apps, app.id, appOperationCallName('list'))).toEqual([])
    expect((await apps.calls(owner, app.id))[1]).toMatchObject({ operation: 'sneak', outcome: 'failed' })
  })

  test('an operation refuses input its schema does not accept', async () => {
    const apps = await service()
    const { app } = await deploy(apps, await project(NOTES))
    await expect(call(apps, app.id, appOperationCallName('add'), { text: 7 })).rejects.toThrow('Invalid input for add')
    await expect(call(apps, app.id, appOperationCallName('missing'))).rejects.toThrow('This app has no operation named missing.')
  })

  test('a new version keeps the data and applies only its new migrations', async () => {
    // WHY: a deploy changes code, never data. A migration that ran once must
    // not run again, or the second deploy of any app would fail.
    const apps = await service()
    const { app } = await deploy(apps, await project(NOTES))
    await call(apps, app.id, appOperationCallName('add'), { text: 'kept' })
    const next = await deploy(apps, await project({
      ...NOTES,
      app: NOTES.app.replace("'SELECT id, text FROM notes ORDER BY id'", "'SELECT id, text, done FROM notes ORDER BY id'"),
      migrations: { ...NOTES.migrations, '0002_done.sql': 'ALTER TABLE notes ADD COLUMN done INTEGER NOT NULL DEFAULT 0;' },
    }), 'notes')
    expect(next).toMatchObject({ version: 2, active: true, created: false })
    expect(await call(apps, app.id, appOperationCallName('list'))).toEqual([{ id: 1, text: 'kept', done: 0 }])
    expect((await apps.versions(owner, app.id)).map((version) => [version.number, version.state])).toEqual([[2, 'active'], [1, 'superseded']])
    const diff = await apps.versionDiff(owner, app.id, 2)
    expect(diff).toMatchObject({ version: 2, base: 1, truncated: false })
    expect(diff.patch).toContain('+ALTER TABLE notes ADD COLUMN done')
  })

  test('a version that does not start is recorded as failed, and the version before it still runs', async () => {
    // WHY: a bad deploy must not take a working app down.
    const apps = await service()
    const { app } = await deploy(apps, await project(NOTES))
    await call(apps, app.id, appOperationCallName('add'), { text: 'still here' })
    const broken = await deploy(apps, await project({ ...NOTES, migrations: { ...NOTES.migrations, '0002_bad.sql': 'ALTER TABLE missing ADD COLUMN x;' } }), app.id)
    expect(broken).toMatchObject({ version: 2, active: false })
    expect(broken.error).toContain('The migration 0002_bad.sql failed')
    expect(broken.app).toMatchObject({ activeVersion: 1, latestVersion: 2 })
    expect(broken.app.attention.map((item) => item.kind)).toContain('version-failed')
    expect(await call(apps, app.id, appOperationCallName('list'))).toEqual([{ id: 1, text: 'still here' }])
  })

  test('an earlier version can be made active again; the data is not rewound', async () => {
    const apps = await service()
    const { app } = await deploy(apps, await project(NOTES))
    await deploy(apps, await project({ ...NOTES, app: NOTES.app.replace("name: 'Notes'", "name: 'Notes two'") }), app.id)
    await call(apps, app.id, appOperationCallName('add'), { text: 'written by version 2' })
    const state = await apps.activate(owner, app.id, 1)
    expect(state.app).toMatchObject({ activeVersion: 1, name: 'Notes', slug: 'notes' })
    expect(await call(apps, app.id, appOperationCallName('list'))).toEqual([{ id: 1, text: 'written by version 2' }])
  })

  test('a stopped app runs no operation until it is started', async () => {
    const apps = await service()
    const { app } = await deploy(apps, await project(NOTES))
    expect((await apps.stop(owner, app.id)).app.attention.map((item) => item.kind)).toContain('stopped')
    await expect(call(apps, app.id, appOperationCallName('list'))).rejects.toThrow('This app is stopped.')
    expect(await apps.running(owner)).toEqual([])
    await apps.start(owner, app.id)
    expect(await call(apps, app.id, appOperationCallName('list'))).toEqual([])
  })

  test('a secret reaches the backend and never a client', async () => {
    // WHY: a database URL or a key must not be in the app's data, where the UI reads it.
    const apps = await service()
    const { app } = await deploy(apps, await project(NOTES))
    expect((await call(apps, app.id, appOperationCallName('whoAndWhat'))).token).toBeNull()
    const state = await apps.secretSet(owner, app.id, 'token', 's3cret')
    expect(state.secrets).toEqual([{ name: 'token', label: 'API token', description: '', isSet: true }])
    expect(JSON.stringify(state)).not.toContain('s3cret')
    expect(await call(apps, app.id, appOperationCallName('whoAndWhat'))).toEqual({ caller: { kind: 'ui' }, token: 's3cret' })
    await expect(apps.secretSet(owner, app.id, 'other', 'x')).rejects.toThrow('This app declares no secret named other.')
    await apps.secretSet(owner, app.id, 'token', null)
    expect((await call(apps, app.id, appOperationCallName('whoAndWhat'))).token).toBeNull()
  })

  test('the backend calls an integration the app names, with the caller\'s own integration', async () => {
    const apps = await service()
    const { app } = await deploy(apps, await project(NOTES))
    expect(await call(apps, app.id, appOperationCallName('issues'))).toEqual({ issues: ['ENG-1'] })
    expect(toolCalls).toEqual([{ integrationId: 'int-linear', tool: 'list_issues', input: { team: 'ENG' } }])
    // The UI reaches the same integration by its call name, and no integration the app does not name.
    expect(await call(apps, app.id, 'linear/list_issues', { team: 'OPS' })).toEqual({ issues: ['ENG-1'] })
    await expect(call(apps, app.id, 'github/list_issues')).rejects.toThrow('This app does not name the integration github.')
  })

  test('storage is the app\'s own, with no backend call', async () => {
    const apps = await service()
    const { app } = await deploy(apps, await project(NOTES))
    await call(apps, app.id, appStorageCallName('set'), { key: 'view', value: { sort: 'new' } })
    expect(await call(apps, app.id, appStorageCallName('get'), { key: 'view' })).toEqual({ sort: 'new' })
    expect(await call(apps, app.id, appStorageCallName('keys'))).toEqual(['view'])
  })

  test('only the owner of the host uses an app', async () => {
    // WHY: an app is code on the host with the owner's files in reach (decision 10).
    const apps = await service()
    const { app } = await deploy(apps, await project(NOTES))
    expect(await apps.list(member)).toEqual([])
    await expect(apps.read(member, app.id)).rejects.toThrow('Only the owner of this host can use its apps.')
    await expect(apps.call(member, app.id, appOperationCallName('list'), '{}')).rejects.toThrow('Only the owner of this host can use its apps.')
    await expect(apps.deploy(member, { project: await project(NOTES), createdBy: by })).rejects.toThrow('Only the owner of this host can use its apps.')
  })

  test('a second app with the same name, and a name an integration has, get another slug', async () => {
    // WHY: an app's slug and an integration's slug are both `tools.<slug>` to an agent.
    const apps = await service()
    expect((await deploy(apps, await project(NOTES))).app.slug).toBe('notes')
    expect((await deploy(apps, await project(NOTES))).app.slug).toBe('notes-2')
    expect((await deploy(apps, await project({ ...NOTES, app: NOTES.app.replace("name: 'Notes'", "name: 'Linear'") }))).app.slug).toBe('linear-2')
  })

  test('the source of a version comes back out of the repository as files', async () => {
    // WHY: a later session changes an app from its source; the host is the only place that keeps it.
    const apps = await service()
    const { app } = await deploy(apps, await project(NOTES))
    const folder = join(projects, 'checkout')
    const written = await apps.checkout(owner, 'notes', folder)
    expect(written).toMatchObject({ version: 1, files: 4 })
    expect(readFileSync(join(folder, 'app.ts'), 'utf8')).toBe(NOTES.app)
    expect(readFileSync(join(folder, 'migrations/0001_notes.sql'), 'utf8')).toBe(NOTES.migrations?.['0001_notes.sql'])
    // The build is in the repository too, on its own ref, and not in the source.
    expect(existsSync(join(folder, 'dist'))).toBe(false)
    const refs = spawnSync('git', ['--git-dir', await apps.repositoryPath(owner, app.id), 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' }).stdout.trim().split('\n')
    expect(refs).toEqual(['refs/heads/main', 'refs/solus/versions/1'])
  })

  test('a deleted app leaves nothing on the host', async () => {
    const apps = await service()
    const { app } = await deploy(apps, await project(NOTES))
    await call(apps, app.id, appOperationCallName('add'), { text: 'gone soon' })
    await apps.secretSet(owner, app.id, 'token', 's3cret')
    const repository = await apps.repositoryPath(owner, app.id)
    expect(await apps.delete(owner, app.id)).toBe(true)
    expect(existsSync(repository)).toBe(false)
    expect(existsSync(join(dataDir, 'apps', 'data', app.id))).toBe(false)
    expect(await apps.list(owner)).toEqual([])
    expect(await store.listCalls(app.id, 10)).toEqual([])
    await expect(apps.read(owner, app.id)).rejects.toThrow('This app is not available.')
  })

  test('a schedule runs its mutation with no caller there, from the deploy that declares it', async () => {
    // WHY: an app works when nobody looks at it. A schedule is on from the
    // deploy (decision 14), runs as the app's owner, and records how it ended.
    const apps = await service()
    let now = Date.parse('2026-11-12T10:00:00Z')
    const schedules = new schedulesModule.AppSchedules(apps, () => now)
    apps.addLifecyclePart(schedules)
    const { app } = await deploy(apps, await project(NOTES))
    expect(await schedules.list(owner, app.id)).toEqual([expect.objectContaining({ name: 'tick', run: 'add', enabled: true, nextRunAt: now + 5 * 60_000, lastOutcome: null })])

    await schedules.tick()
    expect(await call(apps, app.id, appOperationCallName('list'))).toEqual([])
    now += 5 * 60_000
    await schedules.tick()
    await Bun.sleep(0)
    for (let wait = 0; wait < 100 && (await schedules.list(owner, app.id))[0]?.lastOutcome === null; wait += 1) await Bun.sleep(20)
    expect(await call(apps, app.id, appOperationCallName('list'))).toEqual([{ id: 1, text: 'tick' }])
    expect((await schedules.list(owner, app.id))[0]).toMatchObject({ lastOutcome: 'ok', lastRunAt: now, nextRunAt: now + 5 * 60_000 })
    expect((await apps.calls(owner, app.id)).find((entry) => entry.caller.kind === 'schedule')).toMatchObject({ operation: 'add', caller: { kind: 'schedule', name: 'tick' } })

    // A paused schedule is not due; a version that no longer declares it removes it.
    expect((await schedules.set(owner, app.id, 'tick', false))[0]).toMatchObject({ enabled: false, nextRunAt: null })
    now += 60 * 60_000
    await schedules.tick()
    expect(await call(apps, app.id, appOperationCallName('list'))).toHaveLength(1)
    await deploy(apps, await project({ ...NOTES, app: NOTES.app.replace("schedules: { tick: { every: { minutes: 5 }, run: 'add', input: { text: 'tick' } } },", '') }), app.id)
    expect(await schedules.list(owner, app.id)).toEqual([])
    schedules.stop()
  })

  test('each webhook an app declares is a webhook record that calls its mutation', async () => {
    // WHY: the webhook owner holds the URL, the check, and the log; the app only says which mutation runs.
    const apps = await service()
    const records = new Map<string, { name: string; actions: object[] }>()
    const webhooks = new webhooksModule.AppWebhooks(apps, {
      create: async (input) => {
        const id = `hook-${records.size + 1}`
        records.set(id, { name: input.name, actions: input.actions })
        // SAFETY: the part reads only the id of what it made.
        return { id } as never
      },
      update: async (id, patch) => {
        const record = records.get(id)
        if (!record) return null
        records.set(id, { name: patch.name ?? record.name, actions: patch.actions ?? record.actions })
        // SAFETY: the part reads only whether the update found the record.
        return { id } as never
      },
      delete: async (id) => records.delete(id),
      readWithUrl: async () => null,
    })
    apps.addLifecyclePart(webhooks)
    const { app } = await deploy(apps, await project(NOTES))
    expect([...records.values()]).toEqual([{ name: 'Notes: pushed', actions: [{ id: 'app', type: 'call_app', enabled: true, filters: [], template: '', appId: app.id, operation: 'add' }] }])

    // A webhook's request is the mutation's input, and the call names the webhook.
    await apps.callOperation(app.id, 'add', { text: 'from a webhook' }, { kind: 'webhook', webhookId: 'hook-1' }, null)
    expect((await apps.calls(owner, app.id))[0]).toMatchObject({ caller: { kind: 'webhook', webhookId: 'hook-1' }, outcome: 'ok' })

    await deploy(apps, await project(NOTES), app.id)
    expect(records.size).toBe(1)
    await deploy(apps, await project({ ...NOTES, app: NOTES.app.replace("webhooks: { pushed: { verify: { scheme: 'token', source: { kind: 'header', name: 'x-token' } }, run: 'add' } },", '') }), app.id)
    expect(records.size).toBe(0)
  })

  test('each operation of a running app is a tool for an agent', async () => {
    // WHY: an app the user asked for is something their agents can use, not only a screen.
    const apps = await service()
    const { app } = await deploy(apps, await project(NOTES))
    const agentTools = await tools.appOperationAgentTools(owner.actor, new Set(['notes__sneak']))
    expect(agentTools.map((tool) => tool.name)).toEqual(['notes__list', 'notes__add', 'notes__whoAndWhat', 'notes__issues'])
    const add = agentTools.find((tool) => tool.name === 'notes__add')
    expect(add?.description).toBe('Notes: Save one note.')
    expect(Object.keys(add?.inputFields ?? {})).toEqual(['text'])
    // SAFETY: the tool reads only the session id of its context.
    const result = await add?.execute({ text: 'by an agent' }, { sessionId: () => 'session-1' } as never)
    expect(result).toEqual({ ok: true, text: JSON.stringify({ id: 1, text: 'by an agent' }, null, 1) })
    expect((await apps.calls(owner, app.id))[0]).toMatchObject({ caller: { kind: 'agent', sessionId: 'session-1' } })
    expect(await tools.appOperationAgentTools(member.actor, new Set())).toEqual([])
  })

  test('deploy_app makes the app from a project folder and links it to the session that deployed it', async () => {
    // WHY: the app must be found from the conversation that made it (decision 18),
    // and the receipt is all the agent knows of what the deploy did.
    const apps = await service()
    const uninstall = await installTestWorkspaceTools()
    const { ensureSessionRow } = await import('@solus/server/data/sessions/session-identity')
    const { readOwnSessionArtifacts } = await import('@solus/server/data/sessions/session-artifacts')
    const { readAppSessionLinks } = await import('@solus/server/data/sessions/session-links')
    const { ANY_ORGANIZATION } = await import('@solus/server/admission/principal')
    await ensureSessionRow('session-1')
    // SAFETY: the tools read the working directory, the session id, and the provider of their context.
    const context = { cwd: projects, sessionId: () => 'session-1', provider: 'claude-code' } as never
    const folder = await project(NOTES)

    const deployed = await tools.deployAppAgentTool.execute({ path: folder, message: 'First' }, context)
    expect(deployed.text).toContain('Deployed "Notes" (app: notes, id: ')
    expect(deployed.ok).toBe(true)
    expect(deployed.text).toContain('as version 1. It is active and linked to this session.')
    expect(deployed.text).toContain('This app runs its own code on this host.')
    expect(deployed.text).toContain('Not set: token.')
    expect(deployed.text).toContain('Its operations are tools named notes__<operation> from the next turn.')

    const [app] = await apps.list(owner)
    expect(await readOwnSessionArtifacts(ANY_ORGANIZATION, 'session-1')).toEqual([expect.objectContaining({ kind: 'app', appId: app?.id, slug: 'notes', title: 'Notes', hostId: 'test-host' })])
    expect((await readAppSessionLinks(app?.id ?? '')).map((link) => link.sessionId)).toEqual(['session-1'])

    // A project with no build is refused with what to do, and a version that does not start says which version still runs.
    expect((await tools.deployAppAgentTool.execute({ path: projects }, context)).text).toContain('deploy_app refused the project: This folder has no app build')
    const broken = await tools.deployAppAgentTool.execute({ path: await project({ ...NOTES, migrations: { '0001_notes.sql': NOTES.migrations?.['0001_notes.sql'] ?? '', '0002_bad.sql': 'DROP TABLE missing;' } }), app: 'notes' }, context)
    expect(broken.ok).toBe(false)
    expect(broken.text).toContain('Version 2 of "Notes" (app: notes) did not start: The migration 0002_bad.sql failed')
    expect(broken.text).toContain('Version 1 still runs.')

    // checkout_app and list_apps are how a later session finds and changes the app.
    const listed = await tools.listAppsAgentTool.execute({}, context)
    expect(listed.text).toContain('- notes (id: ')
    expect(listed.text).toContain('    mutation add: Save one note.')
    expect(listed.text).toContain('    needs the user: Version 2 did not start')
    const checkedOut = await tools.checkoutAppAgentTool.execute({ app: 'notes', path: 'again' }, context)
    expect(checkedOut.text).toContain(`Wrote the source of "Notes" version 2 to ${join(projects, 'again')}`)

    // A deleted app leaves no session linked to it when the host wires that part (boot-server.ts).
    const { unlinkAppFromSessions } = await import('@solus/server/data/sessions/session-links')
    apps.addLifecyclePart({ activated: async () => {}, removed: (removed) => unlinkAppFromSessions(removed.id) })
    await apps.delete(owner, app?.id ?? '')
    expect(await readOwnSessionArtifacts(ANY_ORGANIZATION, 'session-1')).toEqual([])
    uninstall()
  })
})
