import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
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

mock.module('node:sqlite', () => ({ DatabaseSync }))

type DbModule = typeof import('@solus/server/db')
type WorksModule = typeof import('@solus/server/data/works/works')
type AppsModule = typeof import('@solus/server/apps/apps')
type AppStorageModule = typeof import('@solus/server/apps/app-storage')
type AppFunctionsModule = typeof import('@solus/server/apps/app-functions')

/** The runner needs a real Node with the permission model; a machine without one skips the host function cases. */
const nodeVersion = spawnSync('node', ['-p', 'process.versions.node'], { encoding: 'utf8' })
const testWithNode = nodeVersion.status === 0 && Number(nodeVersion.stdout.split('.')[0]) >= 22 ? test : test.skip

let dataDir: string
let db: DbModule
let works: WorksModule
let appsModule: AppsModule
let storageModule: AppStorageModule
let functionsModule: AppFunctionsModule
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
  // The shell is a build output that a test run may not have; the document needs only that one exists.
  mkdirSync(join(dataDir, 'install', 'resources', 'app-shell'), { recursive: true })
  writeFileSync(join(dataDir, 'install', 'resources', 'app-shell', 'shell.js'), 'window.SolusAppShell = {}')
  process.env.SOLUS_INSTALL_DIR = join(dataDir, 'install')
})

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

  test('an app with no server module has no host functions, and a component is such an app', async () => {
    const { apps } = service()
    const work = await createApp('export default function App() { return null }')
    expect(await apps.toolInfo({ workId: work.id, name: appFunctionCallName('greet') }, owner)).toMatchObject({ callable: false, refusal: 'This app has no host functions.' })
  })
})
