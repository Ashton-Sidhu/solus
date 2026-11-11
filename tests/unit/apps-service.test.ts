import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appFunctionCallName, appStorageCallName, DEFAULT_APP_PERMISSIONS } from '@solus/contracts/apps'
import { mcpAppDocument } from '@solus/contracts/mcp-apps'
import { DatabaseSync } from './helpers/bun-sqlite'
import { memberPrincipal, withActor } from './helpers/actors'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'
import { resetTestDatabase } from './helpers/test-db'
import { installTestWorkspaceTools } from './helpers/workspace-tools'

mock.module('node:sqlite', () => ({ DatabaseSync }))

type DbModule = typeof import('@solus/server/db')
type WorksModule = typeof import('@solus/server/data/works/works')
type AppsModule = typeof import('@solus/server/apps/apps')
type AppStorageModule = typeof import('@solus/server/apps/app-storage')
type AppFunctionsModule = typeof import('@solus/server/apps/app-functions')
type AppToolsModule = typeof import('@solus/server/execution/agents/tools/app-tools')
type WorkToolsModule = typeof import('@solus/server/execution/agents/tools/work-tools')

/** The runner needs a real Node with the permission model; a machine without one skips the host function cases. */
const nodeVersion = spawnSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8' })
const testWithNode = nodeVersion.status === 0 && Number(nodeVersion.stdout.split('.')[0]) >= 22 ? test : test.skip

let dataDir: string
let db: DbModule
let works: WorksModule
let appsModule: AppsModule
let storageModule: AppStorageModule
let functionsModule: AppFunctionsModule
let appTools: AppToolsModule
let workTools: WorkToolsModule
let functions: InstanceType<AppFunctionsModule['AppFunctions']> | null = null
const previousDataDir = process.env.SOLUS_DATA_DIR
const previousInstallDir = process.env.SOLUS_INSTALL_DIR

const SERVER = 'exports.greet = async ({ name }, context) => ({ text: "hello " + name, dataDir: context.dataDir })'
const bundle = (extra: { server?: string } = {}) => JSON.stringify({ solusApp: 1, client: 'exports.default = function App() { return null }', integrations: [], ...extra })

/** The gateway and the store are not reached by an app that names no integration. */
const gateway = {
  callAppTool: async () => ({ content: [] }),
  toolsFor: async () => [],
  connectionStatus: async () => ({ status: 'connected' as const }),
}
const store = { getBySlug: () => null }

const owner = TEST_HANDLER_CTX
const member = withActor({ clientId: 'member', principal: memberPrincipal('ann', 'Ann', { organizationId: 'local' }) })

beforeAll(async () => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'solus-apps-service-')))
  process.env.SOLUS_DATA_DIR = dataDir
  db = await import('@solus/server/db')
  works = await import('@solus/server/data/works/works')
  appsModule = await import('@solus/server/apps/apps')
  storageModule = await import('@solus/server/apps/app-storage')
  functionsModule = await import('@solus/server/apps/app-functions')
  appTools = await import('@solus/server/execution/agents/tools/app-tools')
  workTools = await import('@solus/server/execution/agents/tools/work-tools')
  // The shell is a build output that a test run may not have; the document needs only that one exists.
  mkdirSync(join(dataDir, 'install', 'resources', 'app-shell'), { recursive: true })
  writeFileSync(join(dataDir, 'install', 'resources', 'app-shell', 'shell.js'), 'window.SolusAppShell = {}')
  process.env.SOLUS_INSTALL_DIR = join(dataDir, 'install')
})

beforeEach(async () => { await installTestWorkspaceTools() })

afterEach(async () => {
  functions?.dispose()
  functions = null
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
  if (previousInstallDir === undefined) delete process.env.SOLUS_INSTALL_DIR
  else process.env.SOLUS_INSTALL_DIR = previousInstallDir
})

function service() {
  functions = new functionsModule.AppFunctions({ node: 'node' })
  const storage = new storageModule.AppStorage(() => join(dataDir, 'app-data'))
  // SAFETY: the two fakes answer every member `Apps` names in its constructor types.
  return { apps: new appsModule.Apps(gateway as never, store as never, storage, functions), storage }
}

async function createApp(content: string) {
  return works.createWork('local', 'Database browser', 'app', content, '', undefined, 'claude-code')
}

const call = (apps: InstanceType<AppsModule['Apps']>, workId: string, name: string, input: object, ctx = owner) =>
  apps.callTool({ workId, name, argumentsJson: JSON.stringify(input), approved: false }, ctx).then((json) => JSON.parse(json).structuredContent.value)

describe('app storage', () => {
  test('an app keeps its own JSON data on the host, and a deleted app leaves none', async () => {
    // WHY: storage is what lets an app be more than a view. It belongs to the
    // app, so it must go when the app goes and never reach another app.
    const { apps } = service()
    const first = await createApp(bundle())
    const second = await createApp(bundle())
    expect(await call(apps, first.id, appStorageCallName('get'), { key: 'todos' })).toBeNull()
    await call(apps, first.id, appStorageCallName('set'), { key: 'todos', value: [{ text: 'ship', done: false }] })
    await call(apps, first.id, appStorageCallName('set'), { key: 'theme', value: 'dense' })
    expect(await call(apps, first.id, appStorageCallName('get'), { key: 'todos' })).toEqual([{ text: 'ship', done: false }])
    expect(await call(apps, first.id, appStorageCallName('keys'), {})).toEqual(['todos', 'theme'])
    expect(await call(apps, second.id, appStorageCallName('keys'), {})).toEqual([])
    await call(apps, first.id, appStorageCallName('delete'), { key: 'theme' })
    expect(await call(apps, first.id, appStorageCallName('keys'), {})).toEqual(['todos'])

    // A storage call never asks: it is the app's own data.
    expect(await apps.toolInfo({ workId: first.id, name: appStorageCallName('set') }, owner)).toMatchObject({ callable: true, readOnly: true })

    await apps.forget(first.id)
    expect(existsSync(join(dataDir, 'app-data', first.id))).toBe(false)
  })

  test('writes made at once all land', async () => {
    // WHY: each write reads the file first; two at once without an order would lose one.
    const { apps } = service()
    const work = await createApp(bundle())
    await Promise.all(Array.from({ length: 20 }, (_unused, index) => call(apps, work.id, appStorageCallName('set'), { key: `k${index}`, value: index })))
    expect(await call(apps, work.id, appStorageCallName('keys'), {})).toHaveLength(20)
  })
})

describe('app host access', () => {
  test('an app that asks for nothing needs no decision, and has no network', async () => {
    const { apps } = service()
    const work = await createApp(bundle())
    const snapshot = await apps.read({ workId: work.id }, owner)
    expect(snapshot.hostAccess).toEqual({ asks: { functions: false, network: [], files: { read: [], write: [] } }, state: 'none', canDecide: true })
    expect(mcpAppDocument(snapshot.html, snapshot.csp)).toContain("connect-src 'none'")
  })

  test('network hosts are in force only after the host\'s owner allows them, and stop when the owner revokes', async () => {
    // WHY: an agent declares what an app needs. Until the owner reads and
    // allows it, an app must not send what it reads to a host the agent chose.
    const { apps } = service()
    const work = await createApp(bundle())
    const pending = await apps.permissionsUpdate({ workId: work.id, permissions: { ...DEFAULT_APP_PERMISSIONS, network: ['api.example.com'] } }, owner)
    expect(pending.hostAccess.state).toBe('pending')
    expect(pending.csp).toEqual({})
    expect(pending.html).toContain('"hostAccess":"pending"')

    await expect(apps.hostAccessDecide({ workId: work.id, allow: true }, member)).rejects.toThrow('Only the owner of this host')

    const allowed = await apps.hostAccessDecide({ workId: work.id, allow: true }, owner)
    expect(allowed.hostAccess.state).toBe('allowed')
    expect(allowed.csp).toEqual({ connectDomains: ['https://api.example.com', 'wss://api.example.com'] })

    // The agent widens the request: the old decision does not cover it.
    await apps.permissionsUpdate({ workId: work.id, permissions: { ...DEFAULT_APP_PERMISSIONS, network: ['api.example.com', 'other.example.com'] } }, owner)
    expect((await apps.read({ workId: work.id }, owner)).hostAccess.state).toBe('pending')
    // It narrows it again: the decision stands and the person's tool settings did not erase it.
    await apps.permissionsUpdate({ workId: work.id, permissions: { ...DEFAULT_APP_PERMISSIONS, tools: 'read-only', network: ['api.example.com'] } }, owner)
    expect((await apps.read({ workId: work.id }, owner)).hostAccess.state).toBe('allowed')

    const revoked = await apps.hostAccessDecide({ workId: work.id, allow: false }, owner)
    expect(revoked.hostAccess.state).toBe('pending')
    expect(revoked.csp).toEqual({})
  })

  testWithNode('a host function runs only after the owner allows it, only for the owner, and not after a revoke', async () => {
    // WHY: a host function is code an agent wrote, with the owner's files and
    // network. Nothing of it may run before the owner says so, or for anyone else.
    const { apps } = service()
    const work = await createApp(bundle({ server: SERVER }))
    const greet = appFunctionCallName('greet')

    expect((await apps.read({ workId: work.id }, owner)).hostAccess).toMatchObject({ asks: { functions: true }, state: 'pending' })
    expect(await apps.toolInfo({ workId: work.id, name: greet }, owner)).toMatchObject({ callable: false, refusal: expect.stringContaining('waits for its host access') })
    await expect(call(apps, work.id, greet, { name: 'Ann' })).rejects.toThrow('waits for its host access')

    await apps.hostAccessDecide({ workId: work.id, allow: true }, owner)
    expect(await call(apps, work.id, greet, { name: 'Ann' })).toEqual({ text: 'hello Ann', dataDir: join(dataDir, 'app-data', work.id, 'data') })

    await expect(call(apps, work.id, greet, { name: 'Ann' }, member)).rejects.toThrow('Only the owner of the host can run it')
    expect((await apps.read({ workId: work.id }, member)).hostAccess.canDecide).toBe(false)

    await apps.hostAccessDecide({ workId: work.id, allow: false }, owner)
    await expect(call(apps, work.id, greet, { name: 'Ann' })).rejects.toThrow('waits for its host access')
  })

  test('a copy of an allowed app asks for its host access again', async () => {
    // WHY: the owner allowed one app. A copy belongs to whoever made it and
    // can get other code; it must not run under a decision made for the first.
    const { apps } = service()
    const work = await createApp(bundle({ server: SERVER }))
    await apps.hostAccessDecide({ workId: work.id, allow: true }, owner)
    const copy = await works.duplicateWork('local', work.id)
    expect((await apps.read({ workId: work.id }, owner)).hostAccess.state).toBe('allowed')
    expect((await apps.read({ workId: copy.id }, owner)).hostAccess.state).toBe('pending')
  })

  test('an app with no server module has no host functions, and a component is such an app', async () => {
    const { apps } = service()
    const work = await createApp('export default function App() { return null }')
    expect(await apps.toolInfo({ workId: work.id, name: appFunctionCallName('greet') }, owner)).toMatchObject({ callable: false, refusal: 'This app has no host functions.' })
  })
})

describe('create_app', () => {
  const ctx = () => ({ sessionId: undefined, agentProvider: 'claude-code' as const, cwd: dataDir })
  const SOURCES = { 'src/App.tsx': 'export default function App() { return null }', 'server.ts': 'export async function greet() { return 1 }' }

  function writeBundle(name: string, content: string): string {
    writeFileSync(join(dataDir, name), content)
    return name
  }

  test('an app project\'s bundle is saved from its file, with the host access it waits for in the receipt', async () => {
    // WHY: a bundle is megabytes, so it is read from the host and never passes
    // through the model. The receipt is the agent's only word that the owner
    // must allow the app before its host functions work.
    const file = writeBundle('app.bundle.json', JSON.stringify({ solusApp: 1, client: 'exports.default = function App() { return null }', server: SERVER, integrations: [], sources: SOURCES }))
    const created = await appTools.executeCreateAppTool(
      { title: 'Database browser', bundle_path: file, permissions: { ...DEFAULT_APP_PERMISSIONS, network: ['*'], files: { read: ['*'], write: [] } } },
      { ctx: ctx() },
    )
    expect(created.ok).toBe(true)
    expect(created.text).toStartWith('Created the app "Database browser" (id: ')
    expect(created.text).toContain('It asks to run its own code on this host, read every file, and reach every network host. Tell the user to allow that')
    const workId = /\(id: ([^)]+)\)/.exec(created.text)?.[1] ?? ''

    const { apps } = service()
    const snapshot = await apps.read({ workId }, owner)
    expect(snapshot.hostAccess).toMatchObject({ state: 'pending', asks: { functions: true, network: ['*'], files: { read: ['*'], write: [] } } })

    // read_work answers the sources, so a later session can rebuild the project.
    const read = await workTools.executeWorkTool('read_work', { work_id: workId }, { ctx: ctx() })
    expect(read.text).toContain('--- server.ts ---\nexport async function greet()')
    expect(read.text).not.toContain('exports.greet = async')

    // A revision of the page alone, with the same host code and the same request, keeps the owner's decision.
    await apps.hostAccessDecide({ workId, allow: true }, owner)
    const samePage = writeBundle('app.bundle.json', JSON.stringify({ solusApp: 1, client: 'exports.default = function App() { return 1 }', server: SERVER, integrations: [], sources: SOURCES }))
    const revised = await appTools.executeCreateAppTool({ title: 'Database browser', bundle_path: samePage, work_id: workId, expected_content_version: 1 }, { ctx: ctx() })
    expect(revised.text).toStartWith('Updated the app "Database browser"')
    expect(revised.text).not.toContain('It asks to')
    expect((await apps.read({ workId }, owner)).hostAccess.state).toBe('allowed')

    // A revision of the host code is other code: it asks again, and the receipt says so.
    const newCode = writeBundle('app.bundle.json', JSON.stringify({ solusApp: 1, client: 'exports.default = function App() { return 1 }', server: `${SERVER}; exports.more = async () => 2`, integrations: [] }))
    const changed = await appTools.executeCreateAppTool({ title: 'Database browser', bundle_path: newCode, work_id: workId, expected_content_version: 2 }, { ctx: ctx() })
    expect(changed.text).toContain('It asks to run its own code on this host')
    expect((await apps.read({ workId }, owner)).hostAccess.state).toBe('pending')
  })

  test('a call names one of code or bundle_path, a file that is not a bundle is refused, and permissions that do not parse are refused, never dropped', async () => {
    const component = 'export default function App() { return null }'
    expect((await appTools.executeCreateAppTool({ title: 'A' }, { ctx: ctx() })).text).toBe('create_app takes one of code or bundle_path.')
    expect((await appTools.executeCreateAppTool({ title: 'A', code: component, bundle_path: 'app.bundle.json' }, { ctx: ctx() })).text).toBe('create_app takes one of code or bundle_path.')
    // An agent that fills the unused input with an empty string still means one of them.
    expect((await appTools.executeCreateAppTool({ title: 'A', code: component, bundle_path: '' }, { ctx: ctx() })).ok).toBe(true)
    expect((await appTools.executeCreateAppTool({ title: 'A', bundle_path: writeBundle('notes.json', '{"hello":1}') }, { ctx: ctx() })).text).toContain('create_app refused the app')
    expect((await appTools.executeCreateAppTool({ title: 'A', bundle_path: writeBundle('bad.json', '{"solusApp":1}') }, { ctx: ctx() })).text).toContain('The app bundle is not valid: client')
    expect((await appTools.executeCreateAppTool({ title: 'A', bundle_path: 'missing.json' }, { ctx: ctx() })).text).toContain('bundle_path not found')
    // SAFETY: the malformed input is the case under test.
    const refused = await appTools.executeCreateAppTool({ title: 'A', code: component, permissions: { network: ['https://api.example.com'] } as never }, { ctx: ctx() })
    expect(refused).toMatchObject({ ok: false, text: expect.stringContaining('create_app refused the permissions: network.0') })
  })
})
