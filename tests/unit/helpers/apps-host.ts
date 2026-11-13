import { afterAll, afterEach, beforeAll, describe, mock } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installTestIdentities } from './acting-identities'
import { testAppBuilder, writeAppProject, type AppProjectFiles } from './app-project'
import { DatabaseSync } from './bun-sqlite'
import { memberPrincipal, withActor } from './actors'
import { TEST_HANDLER_CTX } from './handler-ctx'
import { resetTestDatabase } from './test-db'

mock.module('node:sqlite', () => ({ DatabaseSync }))

type AppsModule = typeof import('@solus/server/apps/apps')
export type Apps = InstanceType<AppsModule['Apps']>
type RunnersModule = typeof import('@solus/server/apps/app-runners')
type SchedulesModule = typeof import('@solus/server/apps/app-schedules')
type WebhooksModule = typeof import('@solus/server/apps/app-webhooks')
type StoreModule = typeof import('@solus/server/data/apps/app-store')
type EventsModule = typeof import('@solus/server/apps/app-events')
type ToolsModule = typeof import('@solus/server/execution/agents/tools/app-tools')
type WorkflowsModule = typeof import('@solus/server/apps/app-workflows')
type SignalsModule = typeof import('@solus/server/apps/app-signals')
type FilesModule = typeof import('@solus/server/apps/app-files')

/**
 * What the app service tests share (`apps-service.test.ts`,
 * `apps-runtime.test.ts`, `apps-tools.test.ts`). The Apps service against a real host: a real database, a real git
 * repository for each app, and a real Node runner. The builder is the test
 * one (`helpers/app-project.ts`): it builds each revision in a new folder as
 * the host's bundler does, with no npm. Bun has no permission model, so a
 * machine with no Node 22 or later skips these.
 */
const nodeVersion = spawnSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8' })
export const describeWithNode = nodeVersion.status === 0 && Number(nodeVersion.stdout.split('.')[0]) >= 22 ? describe : describe.skip

export const NOTES: AppProjectFiles = {
  app: `import { defineApp, query, mutation } from '@solus/app/backend'
import { z } from 'zod'
export default defineApp({
  name: 'Notes',
  description: 'Keeps notes.',
  secrets: { token: { label: 'API token' } },
  integrations: ['linear', 'github', 'atlassian'],
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

/** An app that uses the runtime of the fifth model: app files, log lines, a workflow, and a signal. */
export const REPORTS: AppProjectFiles = {
  app: `import { defineApp, query, mutation, workflow, signal, NonRetryableError } from '@solus/app/backend'
import { z } from 'zod'
export default defineApp({
  name: 'Reports',
  instructions: 'Call list before you make a report.',
  signals: { 'report.ready': signal({ description: 'A report is ready.', payload: z.object({ title: z.string(), rows: z.number() }) }) },
  operations: {
    list: query({ description: 'Every report.', output: z.array(z.object({ title: z.string(), rows: z.number() })) }, (ctx) => ctx.sql.exec('SELECT title, rows FROM reports ORDER BY title').all()),
    save: mutation({ input: z.object({ title: z.string(), rows: z.number() }) }, (ctx, report) => {
      console.log('saving', report.title)
      ctx.sql.exec('INSERT INTO reports (title, rows) VALUES (?, ?)', report.title, report.rows)
      ctx.signals.emit('report.ready', report)
      return null
    }),
    request: mutation({ input: z.object({ title: z.string(), fileId: z.string().optional(), fail: z.boolean().optional() }) }, (ctx, input) => ctx.workflows.start('build', input, { key: input.title })),
    count: mutation({ input: z.object({ fileId: z.string() }) }, async (ctx, input) => {
      const lines = (await ctx.files.text(input.fileId)).trim().split('\\n').length
      const made = await ctx.files.write('count.txt', String(lines), 'text/plain')
      return { lines, made: made.name }
    }),
    wrongShape: query({ output: z.object({ total: z.number() }) }, () => ({ total: 'three' })),
    broken: mutation({}, () => { console.error('about to fail'); throw new Error('the report is broken') }),
  },
  workflows: {
    build: workflow({ input: z.object({ title: z.string(), fileId: z.string().optional(), fail: z.boolean().optional() }) }, async (ctx, input) => {
      const rows = await ctx.step.do('count', async (step) => {
        console.log('counting for', input.title)
        if (input.fail) throw new NonRetryableError('the source is gone')
        return input.fileId ? (await step.files.text(input.fileId)).trim().split('\\n').length : 0
      })
      await ctx.step.runMutation('save', 'save', { title: input.title, rows })
      return { rows }
    }),
    later: workflow({}, async (ctx) => {
      await ctx.step.runMutation('before', 'save', { title: 'before the sleep', rows: 1 })
      await ctx.step.sleep('wait', '2 hours')
      await ctx.step.runMutation('after', 'save', { title: 'after the sleep', rows: 2 })
      return 'done'
    }),
  },
})`,
  migrations: { '0001_reports.sql': 'CREATE TABLE reports (title TEXT PRIMARY KEY, rows INTEGER NOT NULL);' },
}

export let dataDir: string
export let projects: string
let appsModule: AppsModule
let runnersModule: RunnersModule
export let schedulesModule: SchedulesModule
export let webhooksModule: WebhooksModule
export let store: StoreModule
export let events: EventsModule
export let tools: ToolsModule
let workflowsModule: WorkflowsModule
export let signalsModule: SignalsModule
let filesModule: FilesModule
let runners: InstanceType<RunnersModule['AppRunners']> | null = null
const previousDataDir = process.env.SOLUS_DATA_DIR

export const owner = TEST_HANDLER_CTX
export const member = withActor({ clientId: 'member', principal: memberPrincipal('ann', 'Ann', { organizationId: 'local' }) })
export const by = { kind: 'system' as const }

export const toolCalls: { integrationId: string; tool: string; input: object }[] = []
const gateway = {
  callAppTool: async (integrationId: string, tool: string, input: object) => {
    toolCalls.push({ integrationId, tool, input })
    return { content: [], structuredContent: { issues: ['ENG-1'] } }
  },
  toolsFor: async () => [],
  connectionStatus: async () => ({ status: 'connected' as const }),
}
/** The built-in connections: GitHub is connected and Atlassian is not. */
export const connectionCalls: { provider: string; input: unknown }[] = []
const connections = {
  connected: async (provider: string) => provider === 'github',
  request: async (provider: string, input: unknown) => {
    connectionCalls.push({ provider, input })
    return [{ number: 7 }]
  },
}
const integrations = { getBySlug: (slug: string) => (slug === 'linear' ? { id: 'int-linear', name: 'Linear', slug: 'linear', disabledTools: [] } : null) }

let stopParts: (() => void)[] = []

/** Registers the hooks of a test file that uses this host: the modules load once, and each test gets an empty host. */
export function installAppsHost(): void {
  beforeAll(async () => {
    dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'solus-apps-service-')))
    projects = realpathSync(mkdtempSync(join(tmpdir(), 'solus-apps-projects-')))
    process.env.SOLUS_DATA_DIR = dataDir
    appsModule = await import('@solus/server/apps/apps')
    runnersModule = await import('@solus/server/apps/app-runners')
    schedulesModule = await import('@solus/server/apps/app-schedules')
    webhooksModule = await import('@solus/server/apps/app-webhooks')
    workflowsModule = await import('@solus/server/apps/app-workflows')
    signalsModule = await import('@solus/server/apps/app-signals')
    filesModule = await import('@solus/server/apps/app-files')
    store = await import('@solus/server/data/apps/app-store')
    events = await import('@solus/server/apps/app-events')
    tools = await import('@solus/server/execution/agents/tools/app-tools')
    // The app's git repository is written as the host itself.
    installTestIdentities()
  })


  afterEach(async () => {
    for (const stop of stopParts.splice(0)) stop()
    runners?.dispose()
    runners = null
    tools.useAppsForTools(null)
    toolCalls.length = 0
    connectionCalls.length = 0
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
}

/** What a signal action sent to a session or an automation. */
export const sent: { kind: 'session' | 'automation'; target: string; prompt: string }[] = []

export interface Host {
  apps: Apps
  builder: ReturnType<typeof testAppBuilder>
  workflows: InstanceType<WorkflowsModule['AppWorkflows']>
  signals: InstanceType<SignalsModule['AppSignals']>
  /** The clock of the workflows part and the signals part. */
  clock: { now: number }
}

/** The apps domain of one host, wired as `boot-server.ts` wires it, with a test builder and a clock. */
export async function host(): Promise<Host> {
  const [{ AppStorage }, { AppRepositories }] = await Promise.all([import('@solus/server/apps/app-storage'), import('@solus/server/apps/app-repository')])
  runners = new runnersModule.AppRunners({ node: 'node' })
  const storage = new AppStorage(() => join(dataDir, 'apps', 'data'))
  const builder = testAppBuilder()
  const clock = { now: Date.now() }
  const apps = new appsModule.Apps({
    // SAFETY: the two fakes answer every member `Apps` names in its dependency types.
    gateway: gateway as never,
    integrations: integrations as never,
    connections,
    storage,
    runners,
    repositories: new AppRepositories(() => join(dataDir, 'apps', 'repositories')),
    builder,
    files: new filesModule.AppFiles(storage),
    runAs: (_personKey, run) => run(),
  })
  const workflows = new workflowsModule.AppWorkflows(apps, runners, () => clock.now)
  sent.length = 0
  const signals = new signalsModule.AppSignals(apps, {
    sendToSession: async (_app, sessionId, prompt) => {
      if (sessionId === 'gone') throw new Error('The target session does not exist.')
      sent.push({ kind: 'session', target: sessionId, prompt })
    },
    runAutomation: async (_app, automationId, prompt) => {
      sent.push({ kind: 'automation', target: automationId, prompt })
      return 'started'
    },
  }, () => clock.now)
  apps.addLifecyclePart(signals)
  apps.addLifecyclePart(workflows)
  apps.useWorkflows(workflows)
  apps.useSignals(signals)
  workflows.start()
  stopParts.push(() => workflows.stop())
  tools.useAppsForTools({ apps, builder, workflows, signals })
  return { apps, builder, workflows, signals, clock }
}

export const service = async (): Promise<Apps> => (await host()).apps

let projectCount = 0
/** A new project folder with these files. */
export function project(files: AppProjectFiles): string {
  const folder = join(projects, `project-${projectCount++}`)
  writeAppProject(folder, files)
  return folder
}

export const save = (apps: Apps, folder: string, app?: string) => apps.save(owner, { project: folder, app, createdBy: by, message: 'A change' })
/** Saves a project folder and deploys the revision: what an agent does with `save_app` and `deploy_app`. */
export async function ship(apps: Apps, folder: string) {
  const saved = await save(apps, folder)
  return { ...(await apps.deploy(owner, { app: saved.app.id, createdBy: by })), created: saved.created, revision: saved.revision }
}
/** Writes other files into the folder of an app and ships them: a change of the app. */
export async function change(apps: Apps, folder: string, files: AppProjectFiles) {
  writeAppProject(folder, files)
  return ship(apps, folder)
}
export const call = async (apps: Apps, appId: string, name: string, input: object = {}) => JSON.parse(await apps.call(owner, appId, name, JSON.stringify(input))).value

/** Waits until `read` answers something that is not null or undefined. */
export async function eventually<T>(read: () => Promise<T | null | undefined>, what: string): Promise<T> {
  for (let wait = 0; wait < 250; wait += 1) {
    const value = await read()
    if (value !== null && value !== undefined) return value
    await Bun.sleep(20)
  }
  throw new Error(`Timed out: ${what}`)
}
