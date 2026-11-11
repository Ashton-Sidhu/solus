import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appFunctionCallName, appManifestBlock, appManifestSchema, appStorageCallName } from '@solus/contracts/apps'
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
type PreviewModule = typeof import('@solus/server/data/works/artifact-preview')
type HtmlPreviewInput = Parameters<PreviewModule['previewArtifactHtml']>[0]

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

const PAGE = '<!doctype html><html><head><title>Table browser</title></head><body><div id="root"></div></body></html>'
const SERVER = 'exports.greet = async ({ name }, context) => ({ text: "hello " + name, dataDir: context.dataDir })'
const SOURCES = { 'src/App.tsx': 'export default function App() { return null }', 'server.ts': 'export async function greet() { return 1 }' }
/** A page as the visual-artifacts build writes it for a project with an app.json. */
const appPage = (extra: object = {}, body = '') => `${PAGE.replace('</body>', `${body}</body>`)}\n${appManifestBlock(appManifestSchema.parse({ solusApp: 1, ...extra }))}\n`

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
})

beforeEach(async () => { await installTestWorkspaceTools() })

afterEach(async () => {
  functions?.dispose()
  functions = null
  appTools.useAppsForTools(null)
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  db.closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

function service() {
  functions = new functionsModule.AppFunctions({ node: 'node' })
  const storage = new storageModule.AppStorage(() => join(dataDir, 'app-data'))
  // SAFETY: the two fakes answer every member `Apps` names in its constructor types.
  const apps = new appsModule.Apps(gateway as never, store as never, storage, functions)
  appTools.useAppsForTools(apps)
  return { apps, storage }
}

const createApp = (html: string) => works.createWork('local', 'Table browser', 'artifact', html, '', undefined, 'claude-code')

const call = (apps: InstanceType<AppsModule['Apps']>, workId: string, name: string, input: object, ctx = owner) =>
  apps.callTool({ workId, name, argumentsJson: JSON.stringify(input), approved: false }, ctx).then((json) => JSON.parse(json).structuredContent.value)

describe('an app is an artifact with a manifest', () => {
  test('an artifact with no manifest is not an app: it has no state, no storage, and no calls', async () => {
    // WHY: every artifact is a page an agent wrote. Only one that says it is
    // an app, and so runs with no open network, may reach the host.
    const { apps } = service()
    const plain = await createApp(PAGE)
    await expect(apps.read({ workId: plain.id }, owner)).rejects.toThrow('This app is not available.')
    await expect(call(apps, plain.id, appStorageCallName('get'), { key: 'a' })).rejects.toThrow('This app is not available.')
  })

  test('a manifest block that is not valid cannot be saved', async () => {
    await expect(createApp(`${PAGE}<script type="application/json" id="solus-app">{"solusApp":2}</script>`)).rejects.toThrow('The app manifest is not valid')
  })
})

describe('app storage', () => {
  test('an app keeps its own JSON data on the host, and a deleted app leaves none', async () => {
    // WHY: storage is what lets an app be more than a view. It belongs to the
    // app, so it must go when the app goes and never reach another app.
    const { apps } = service()
    const first = await createApp(appPage())
    const second = await createApp(appPage())
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
    const work = await createApp(appPage())
    await Promise.all(Array.from({ length: 20 }, (_unused, index) => call(apps, work.id, appStorageCallName('set'), { key: `k${index}`, value: index })))
    expect(await call(apps, work.id, appStorageCallName('keys'), {})).toHaveLength(20)
  })
})

describe('app host access', () => {
  test('an app that asks for nothing needs no decision, and has no network', async () => {
    const { apps } = service()
    const work = await createApp(appPage())
    const state = await apps.read({ workId: work.id }, owner)
    expect(state.hostAccess).toEqual({ asks: { functions: false, writes: false, network: [], files: { read: [], write: [] } }, state: 'none', canDecide: true })
    expect(state.network).toEqual([])
  })

  test('network hosts are in force only after the host\'s owner allows them, and stop when the owner revokes', async () => {
    // WHY: an agent declares what an app needs. Until the owner reads and
    // allows it, an app must not send what it reads to a host the agent chose.
    const { apps } = service()
    const work = await createApp(appPage({ permissions: { network: ['api.example.com'] } }))
    const pending = await apps.read({ workId: work.id }, owner)
    expect(pending.hostAccess.state).toBe('pending')
    expect(pending.network).toEqual([])

    await expect(apps.hostAccessDecide({ workId: work.id, allow: true }, member)).rejects.toThrow('Only the owner of this host')

    const allowed = await apps.hostAccessDecide({ workId: work.id, allow: true }, owner)
    expect(allowed.hostAccess.state).toBe('allowed')
    expect(allowed.network).toEqual(['api.example.com'])

    const revoked = await apps.hostAccessDecide({ workId: work.id, allow: false }, owner)
    expect(revoked.hostAccess.state).toBe('pending')
    expect(revoked.network).toEqual([])
  })

  testWithNode('a host function runs only after the owner allows it, only for the owner, and not after a revoke', async () => {
    // WHY: a host function is code an agent wrote, with the owner's files and
    // network. Nothing of it may run before the owner says so, or for anyone else.
    const { apps } = service()
    const work = await createApp(appPage({ server: SERVER }))
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
    const work = await createApp(appPage({ server: SERVER }))
    await apps.hostAccessDecide({ workId: work.id, allow: true }, owner)
    const copy = await works.duplicateWork('local', work.id)
    expect((await apps.read({ workId: work.id }, owner)).hostAccess.state).toBe('allowed')
    expect((await apps.read({ workId: copy.id }, owner)).hostAccess.state).toBe('pending')
  })

  test('an app with no server module has no host functions', async () => {
    const { apps } = service()
    const work = await createApp(appPage())
    expect(await apps.toolInfo({ workId: work.id, name: appFunctionCallName('greet') }, owner)).toMatchObject({ callable: false, refusal: 'This app has no host functions.' })
  })
})

describe('create_app', () => {
  const ctx = () => ({ sessionId: undefined, agentProvider: 'claude-code' as const, cwd: dataDir })
  /** Stands in for the headless browser: records what a preview was asked to render and with what behind it. */
  function recordedPreview() {
    const inputs: HtmlPreviewInput[] = []
    const preview: PreviewModule['previewArtifactHtml'] = async (input) => {
      inputs.push(input)
      return { screenshot: 'data:image/png;base64,AA==', width: 736, appearance: 'light', contentHeight: 100, console: [], missingImages: [] }
    }
    return { inputs, preview }
  }

  function writePage(name: string, html: string): string {
    writeFileSync(join(dataDir, name), html)
    return name
  }

  test('it saves an app as an artifact, renders it in the conversation, and says what host access it waits for', async () => {
    // WHY: an app is an artifact, so it is saved, rendered, and replayed as
    // one. The receipt is the agent's only word that the owner must allow it.
    const { apps } = service()
    const rendered: Array<{ workId: string; html: string }> = []
    const html = appPage({ server: SERVER, permissions: { network: ['*'], files: { read: ['*'], write: [] } }, sources: SOURCES })
    const created = await appTools.executeCreateAppTool(
      { title: 'Table browser', html_path: writePage('bundle.html', html) },
      { ctx: ctx(), preview: recordedPreview().preview, onArtifact: (artifact) => rendered.push(artifact) },
    )
    expect(created.ok).toBe(true)
    expect(created.text).toStartWith('Rendered "Table browser" in the conversation and saved it as an artifact (id: ')
    expect(created.text).toContain('It asks to run its own code on this host, read every file, and reach every network host. Tell the user to allow that')
    const workId = rendered[0].workId
    expect((await works.loadWork('local', workId))?.type).toBe('artifact')
    expect((await apps.read({ workId }, owner)).hostAccess).toMatchObject({ state: 'pending', asks: { functions: true, network: ['*'] } })

    // read_work answers the sources, so a later session can rebuild the project.
    const read = await workTools.executeWorkTool('read_work', { work_id: workId }, { ctx: ctx() })
    expect(read.text).toContain('--- server.ts ---\nexport async function greet()')
    expect(read.text).not.toContain('<div id="root">')

    // A revision of the page alone keeps the owner's decision; a revision of the host code asks again.
    await apps.hostAccessDecide({ workId, allow: true }, owner)
    const pageOnly = writePage('bundle.html', appPage({ server: SERVER, permissions: { network: ['*'], files: { read: ['*'], write: [] } } }, '<p>new</p>'))
    const revised = await workTools.executeWorkTool('update_work', { work_id: workId, html_path: pageOnly, expected_content_version: 1 }, { ctx: ctx() })
    expect(revised.text).toBe('Updated "Table browser" (artifact, id: ' + workId + '). New content_version: 2.')
    const newCode = writePage('bundle.html', appPage({ server: `${SERVER}; exports.more = async () => 2`, permissions: { network: ['*'], files: { read: ['*'], write: [] } } }))
    const changed = await workTools.executeWorkTool('update_work', { work_id: workId, html_path: newCode, expected_content_version: 2 }, { ctx: ctx() })
    expect(changed.text).toContain('New content_version: 3. It asks to run its own code on this host')
    expect((await apps.read({ workId }, owner)).hostAccess.state).toBe('pending')
  })

  test('it refuses a page that is not an app and a file that is not there, and saves nothing', async () => {
    service()
    const refused = await appTools.executeCreateAppTool({ title: 'A', html_path: writePage('plain.html', PAGE) }, { ctx: ctx(), preview: recordedPreview().preview })
    expect(refused).toMatchObject({ ok: false, text: expect.stringContaining('it has no app manifest. Add an app.json') })
    expect((await appTools.executeCreateAppTool({ title: 'A', html_path: 'missing.html' }, { ctx: ctx() })).text).toContain('html_path not found')
    const broken = writePage('broken.html', `${PAGE}<script type="application/json" id="solus-app">{"solusApp":1,"permissions":{"network":["http://x"]}}</script>`)
    expect((await appTools.executeCreateAppTool({ title: 'A', html_path: broken }, { ctx: ctx() })).text).toContain('create_app refused the page: The app manifest is not valid: permissions.network.0')
  })

  testWithNode('a preview answers the page\'s calls and changes nothing: storage in memory, a host function only for code the owner allowed', async () => {
    // WHY: a preview is the agent looking at its own work. It must not write a
    // person's data, and it must not be a way to run host code the owner has not allowed.
    const { apps, storage } = service()
    const html = appPage({ server: SERVER })
    const file = writePage('bundle.html', html)
    const recorded = recordedPreview()

    const first = await appTools.executeCreateAppTool({ title: 'Table browser', html_path: file, preview: true }, { ctx: ctx(), preview: recorded.preview })
    expect(first.text).toContain('call create_app again without preview')
    const unsaved = recorded.inputs[0].app
    expect(unsaved?.network).toEqual([])
    await unsaved?.call(appStorageCallName('set'), { key: 'url', value: 'x.db' })
    expect(await unsaved?.call(appStorageCallName('get'), { key: 'url' })).toBe('x.db')
    await expect(unsaved?.call(appFunctionCallName('greet'), { name: 'Ann' })).rejects.toThrow('only after the owner of the host allowed this code')
    await expect(unsaved?.call('linear/list_issues', {})).rejects.toThrow('A preview does not call an integration.')

    const work = await createApp(html)
    await storage.set(work.id, 'url', 'saved.db')
    await apps.hostAccessDecide({ workId: work.id, allow: true }, owner)
    await appTools.executeCreateAppTool({ title: 'Table browser', html_path: file, preview: true, work_id: work.id }, { ctx: ctx(), preview: recorded.preview })
    const saved = recorded.inputs[1].app
    // It reads the saved app's storage, and what it writes stays in the preview.
    expect(await saved?.call(appStorageCallName('get'), { key: 'url' })).toBe('saved.db')
    await saved?.call(appStorageCallName('set'), { key: 'url', value: 'preview.db' })
    expect(await saved?.call(appStorageCallName('get'), { key: 'url' })).toBe('preview.db')
    expect(await storage.get(work.id, 'url')).toBe('saved.db')
    expect(await saved?.call(appFunctionCallName('greet'), { name: 'Ann' })).toMatchObject({ text: 'hello Ann' })

    // The same work with other host code: the owner did not allow that code.
    const other = writePage('other.html', appPage({ server: `${SERVER}; exports.more = 1` }))
    await appTools.executeCreateAppTool({ title: 'Table browser', html_path: other, preview: true, work_id: work.id }, { ctx: ctx(), preview: recorded.preview })
    await expect(recorded.inputs[2].app?.call(appFunctionCallName('greet'), { name: 'Ann' })).rejects.toThrow('only after the owner of the host allowed this code')
  })
})
