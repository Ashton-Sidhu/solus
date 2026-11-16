import { afterEach, beforeAll, expect, test } from 'bun:test'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { appModelCallName, appOperationCallName } from '@solus/contracts/apps'
import {
  APP_SERVICE_PATHS,
  APP_VISITOR_HEADER,
  APP_VISITOR_PATHS,
  appContainerLogsRequestSchema,
  appContainerManageRequestSchema,
  appContainerRequestSchema,
  appContainerRunRequestSchema,
  type AppAccessSubject,
  type AppDeploymentView,
} from '@solus/contracts/app-deployments'
import type { AppContainerStatus, AppDeploymentEndpoint, AppDeploymentSpec, AppPlatform, AppPlatformReadiness } from '@solus/server/apps/deployments/app-platform'
import type { AppProjectFiles } from './helpers/app-project'
import { NOTES, REPORTS, by, call, change, connectionCalls, dataDir, describeWithNode, host, installAppsHost, member, owner, project, ship } from './helpers/apps-host'

type DeploymentsModule = typeof import('@solus/server/apps/deployments/app-deployments')
type ConnectedHostModule = typeof import('@solus/server/apps/deployments/connected-host-platform')
type HostedModule = typeof import('@solus/server/apps/deployments/hosted-app-containers')
type ContainerHostApi = import('@solus/server/apps/deployments/connected-host-platform').ContainerHostApi
type DeploymentsOptions = import('@solus/server/apps/deployments/app-deployments').AppDeploymentsOptions
type ConnectedHosts = NonNullable<DeploymentsOptions['connectedHosts']>
type SignIn = NonNullable<DeploymentsOptions['signIn']>
type ModelCallsModule = typeof import('@solus/server/apps/app-model-calls')
type AgentDispatcher = import('@solus/server/execution/agents/agent-runner').AgentDispatcher
type ServiceModule = typeof import('@solus/server/apps/deployments/app-service-api')

/**
 * A published app (docs/plans/app-deploy.md §5), end to end with no Docker:
 * Solus is the Apps service of a test host, and the deployment is the built
 * `solus-apps-runtime` program as a Node process of its own, with its own
 * data folder. The platform below starts that process where the docker
 * platform starts a container; all the rest is the real code of the two
 * sides, over real HTTP.
 */

const repoRoot = resolve(import.meta.dir, '../..')
const RUNTIME_BUNDLE = join(repoRoot, 'dist', 'apps-runtime', 'runtime.js')

/** An app with one connection of each scope (§6): Linear is the caller's own, GitHub is the app's. */
const CONNECTED: AppProjectFiles = {
  app: `import { defineApp, query } from '@solus/app/backend'
export default defineApp({
  name: 'Connected',
  integrations: ['linear'],
  appIntegrations: ['github'],
  operations: {
    mine: query({}, (ctx) => ctx.tools.linear.list_issues({ team: 'ENG' })),
    ours: query({}, (ctx) => ctx.tools.github.request({ path: '/repos/acme/web/pulls' })),
  },
})`,
}

/** Where the docker platform runs a container, this runs the runtime bundle as a process. Its data folder stands for the volume. */
class ProcessPlatform implements AppPlatform {
  readonly kind = 'docker'
  readonly children = new Map<string, ChildProcess>()
  readonly volumes = new Map<string, string>()
  readonly output = new Map<string, string[]>()
  readonly origins = new Map<string, string>()
  /** The env vars of the newest container of each app. */
  readonly envs = new Map<string, AppDeploymentSpec['env']>()
  runs = 0

  async readiness(): Promise<AppPlatformReadiness> {
    return { ready: true }
  }

  private volume(appId: string): string {
    const existing = this.volumes.get(appId)
    if (existing) return existing
    const created = mkdtempSync(join(tmpdir(), 'solus-app-volume-'))
    this.volumes.set(appId, created)
    return created
  }

  async run(spec: AppDeploymentSpec): Promise<AppDeploymentEndpoint> {
    await this.stop(spec.appId)
    this.runs += 1
    this.envs.set(spec.appId, spec.env)
    const child = spawn('node', [RUNTIME_BUNDLE], {
      // The env of a container: what the spec names, and nothing of this test process but its PATH.
      env: { PATH: process.env.PATH, SOLUS_DATA_DIR: this.volume(spec.appId), PORT: '0', ...spec.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.children.set(spec.appId, child)
    const lines: string[] = []
    this.output.set(spec.appId, lines)
    const port = await new Promise<number>((done, fail) => {
      createInterface({ input: child.stdout! }).on('line', (line) => {
        lines.push(line)
        const match = /listens on port (\d+)/.exec(line)
        if (match) done(Number(match[1]))
      })
      child.once('exit', () => fail(new Error('The runtime process ended before it listened.')))
    })
    this.origins.set(spec.appId, `http://127.0.0.1:${port}`)
    return { origin: `http://127.0.0.1:${port}`, address: `http://127.0.0.1:${port}` }
  }

  /** Where the host of the process reaches it, as the docker platform reads the port of a container. */
  async origin(appId: string): Promise<string | null> {
    return (await this.status(appId)).running ? this.origins.get(appId) ?? null : null
  }

  async stop(appId: string): Promise<void> {
    const child = this.children.get(appId)
    if (!child || child.exitCode !== null) return
    await new Promise<void>((done) => {
      child.once('exit', () => done())
      child.kill('SIGTERM')
    })
  }

  async status(appId: string): Promise<AppContainerStatus> {
    const child = this.children.get(appId)
    return { exists: this.volumes.has(appId), running: Boolean(child && child.exitCode === null) }
  }

  async logs(appId: string, lines: number): Promise<string> {
    return (this.output.get(appId) ?? []).slice(-lines).join('\n')
  }

  async remove(appId: string): Promise<void> {
    await this.stop(appId)
    this.children.delete(appId)
    const volume = this.volumes.get(appId)
    if (volume) rmSync(volume, { recursive: true, force: true })
    this.volumes.delete(appId)
  }

  async dispose(): Promise<void> {
    for (const appId of [...this.volumes.keys()]) await this.remove(appId)
  }
}

let deploymentsModule: DeploymentsModule
let serviceModule: ServiceModule
let connectedHostModule: ConnectedHostModule
let hostedModule: HostedModule
let modelCallsModule: ModelCallsModule
let hasRuntimeBundle = false
let cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
installAppsHost()
beforeAll(async () => {
  // The deployment is the program of the image, so the test builds it as the image's build does.
  const built = spawnSync('bun', ['scripts/build-apps-runtime.ts'], { cwd: repoRoot, encoding: 'utf8' })
  hasRuntimeBundle = built.status === 0 && existsSync(RUNTIME_BUNDLE)
  deploymentsModule = await import('@solus/server/apps/deployments/app-deployments')
  serviceModule = await import('@solus/server/apps/deployments/app-service-api')
  connectedHostModule = await import('@solus/server/apps/deployments/connected-host-platform')
  hostedModule = await import('@solus/server/apps/deployments/hosted-app-containers')
  modelCallsModule = await import('@solus/server/apps/app-model-calls')
})

/** What a test gives a Solus beside its platform: the other hosts it reaches, the sign-in of Solus Cloud, a Tailscale key, and a model. */
interface SolusParts {
  connectedHosts?: ConnectedHosts
  signIn?: SignIn
  hasTailscaleKey?: boolean
  dispatcher?: AgentDispatcher
}

/** A Solus with a platform, and its service API on a port. */
async function solus(parts: SolusParts = {}) {
  const platform = new ProcessPlatform()
  let serviceOrigin = ''
  const { apps, signals } = await host()
  const deployments = new deploymentsModule.AppDeployments(apps, {
    runtimeImage: () => 'solus-apps-runtime:test', platforms: [platform], solusUrl: () => serviceOrigin,
    connectedHosts: parts.connectedHosts, signIn: parts.signIn, hasTailscaleKey: () => parts.hasTailscaleKey ?? false,
  })
  apps.addLifecyclePart(deployments)
  // As the host wires it: a model call of a copy runs here, and each operation it uses as a tool runs in the copy.
  const modelCalls = parts.dispatcher
    ? new modelCallsModule.AppModelCalls({
      record: (authority, idOrSlug) => apps.record(authority, idOrSlug),
      callOperation: (appId, operation, input, caller) => deployments.callOperation(appId, { operation, input, caller }),
    }, { dispatcher: parts.dispatcher, resolveModel: (modelId) => ({ provider: 'claude-code', model: modelId || 'default-model' }), callLog: { begin: async () => {}, end: async () => {} } })
    : undefined

  const service = new serviceModule.AppServiceApi({ deployments, apps, signals, modelCalls })
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      void service.answer({ path: request.url ?? '', authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }).then((answer) => {
        response.writeHead(answer.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(answer.body))
      })
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  // SAFETY: a listener on a TCP port answers an AddressInfo.
  serviceOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  cleanups.push(async () => {
    server.closeAllConnections()
    server.close()
    await platform.dispose()
  })
  return { apps, signals, deployments, platform, serviceOrigin: () => serviceOrigin }
}

/** A browser that opens the link of a deployment, as the page of the app does with the secret in the fragment. */
async function visit(deployment: AppDeploymentView, link = deployment.link) {
  const [address = '', secret = ''] = (link ?? '').split('/#')
  let cookie = ''
  const headers = () => ({ 'content-type': 'application/json', [APP_VISITOR_HEADER]: '1', ...(cookie ? { cookie } : {}) })
  const entered = secret ? await fetch(`${address}${APP_VISITOR_PATHS.enter}`, { method: 'POST', headers: headers(), body: JSON.stringify({ secret }) }) : null
  cookie = entered?.headers.get('set-cookie')?.split(';')[0] ?? ''
  const post = async (name: string, input: object) => {
    const response = await fetch(`${address}${APP_VISITOR_PATHS.call}`, { method: 'POST', headers: headers(), body: JSON.stringify({ name, argumentsJson: JSON.stringify(input) }) })
    return response.status === 200 ? response.json() : { status: response.status }
  }
  return {
    entered: entered?.status ?? null,
    page: () => fetch(address, { headers: cookie ? { cookie } : {} }),
    /** What the page asks of `@models`: a call that Solus runs. */
    model: (operation: 'get' | 'cancel', id: string) => post(appModelCallName(operation), { id }),
    call: async (operation: string, input: object = {}) => {
      const response = await fetch(`${address}${APP_VISITOR_PATHS.call}`, { method: 'POST', headers: headers(), body: JSON.stringify({ name: appOperationCallName(operation), argumentsJson: JSON.stringify(input) }) })
      return response.status === 200 ? response.json() : { status: response.status }
    },
  }
}

describeWithNode('a published app', () => {
  test('a publish runs a copy of the active version in a deployment with its own data, and the app in Solus does not change', async () => {
    // WHY (§5): the owner works on the app in Solus, and a publish must not
    // take it away from them. The copy is for other people: what they write
    // there is not in Solus, and what the owner tries in Solus is not there.
    if (!hasRuntimeBundle) return
    const { apps, deployments, platform } = await solus()
    const { app } = await ship(apps, project(NOTES))
    await call(apps, app.id, appOperationCallName('add'), { text: 'written in Solus' })
    expect(await deployments.view(owner, app.id)).toBeNull()

    const { deployment, active } = await deployments.publish(owner, { appId: 'notes' })
    expect(active).toBe(true)
    expect(deployment).toMatchObject({ platform: 'docker', access: 'link', role: 'editor', version: 1, running: true, status: { activeVersion: 1, access: 'link' } })
    // The link is the address with the secret in its fragment: a browser does not send it to a proxy.
    expect(deployment.link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#[A-Za-z0-9_-]{43}$/)

    const browser = await visit(deployment)
    expect(await browser.call('list')).toEqual({ ok: true, value: [] })
    expect(await browser.call('add', { text: 'written by a visitor' })).toEqual({ ok: true, value: { id: 1, text: 'written by a visitor' } })
    expect(await call(apps, app.id, appOperationCallName('list'))).toEqual([{ id: 1, text: 'written in Solus' }])
    expect(existsSync(join(dataDir, 'apps', 'data', app.id, 'app.sqlite'))).toBe(true)
    expect(await deployments.logs(owner, app.id, 50)).toContain('solus-apps-runtime')

    // A publish with nothing new sends the version again and does not start the container again.
    await deployments.publish(owner, { appId: app.id })
    expect(platform.runs).toBe(1)
    expect(await browser.call('list')).toEqual({ ok: true, value: [{ id: 1, text: 'written by a visitor' }] })
  })

  test('a publish sends the version that Solus built, and a version that does not start there leaves the published one running', async () => {
    // WHY (decision 6): the deployment has no source. A version can start on
    // the owner's data and fail on the deployment's own, and then the people
    // who use the app must keep the version they have.
    if (!hasRuntimeBundle) return
    const { apps, deployments } = await solus()
    const folder = project(NOTES)
    const { app } = await ship(apps, folder)
    const first = await deployments.publish(owner, { appId: app.id })
    const browser = await visit(first.deployment)
    await browser.call('add', { text: 'twice' })
    await browser.call('add', { text: 'twice' })

    const done = { ...NOTES, app: NOTES.app.replace("'SELECT id, text FROM notes ORDER BY id'", "'SELECT id, text, done FROM notes ORDER BY id'"), migrations: { ...NOTES.migrations, '0002_done.sql': 'ALTER TABLE notes ADD COLUMN done INTEGER NOT NULL DEFAULT 0;' } }
    await change(apps, folder, done)
    // The deployment still runs what was published: a deploy in Solus is not a publish.
    expect((await browser.call('list')).value).toEqual([{ id: 1, text: 'twice' }, { id: 2, text: 'twice' }])
    expect(await deployments.publish(owner, { appId: app.id })).toMatchObject({ active: true, deployment: { version: 2 } })
    expect((await browser.call('list')).value[0]).toEqual({ id: 1, text: 'twice', done: 0 })

    // This migration applies on the data in Solus, and not on the deployment's, which has the same text two times.
    expect(await change(apps, folder, { ...done, migrations: { ...done.migrations, '0003_unique.sql': 'CREATE UNIQUE INDEX notes_text ON notes (text);' } })).toMatchObject({ version: 3, active: true })
    const failed = await deployments.publish(owner, { appId: app.id })
    expect(failed).toMatchObject({ active: false, deployment: { version: 2, status: { activeVersion: 2 } } })
    expect(failed.error).toContain('Version 3 did not start')
    expect((await browser.call('list')).value).toHaveLength(2)
  })

  test('a published app uses the owner\'s connection only for an app connection, and its signals reach the owner in Solus', async () => {
    // WHY (§6, decision 15): a visitor is no person of Solus. Each visitor
    // acts with an app connection, which the owner chose to give the app, and
    // never with a connection that is the owner's own. No token is in the
    // deployment: Solus runs the tool.
    if (!hasRuntimeBundle) return
    const { apps, signals, deployments, serviceOrigin } = await solus()
    const connected = await ship(apps, project(CONNECTED))
    const reports = await ship(apps, project(REPORTS))
    const browser = await visit((await deployments.publish(owner, { appId: connected.app.id })).deployment)

    expect(await browser.call('ours')).toEqual({ ok: true, value: [{ number: 7 }] })
    expect(connectionCalls).toEqual([{ provider: 'github', input: { path: '/repos/acme/web/pulls' } }])
    const mine = await browser.call('mine')
    expect(mine.ok).toBe(false)
    expect(mine.error).toContain('A published app uses only its app connections. Name linear in `appIntegrations`')

    const reportsBrowser = await visit((await deployments.publish(owner, { appId: reports.app.id })).deployment)
    await reportsBrowser.call('save', { title: 'Q3', rows: 4 })
    expect((await signals.occurrences(owner, reports.app.id, 'report.ready')).map((occurrence) => JSON.parse(occurrence.payload))).toEqual([{ title: 'Q3', rows: 4 }])

    // A key names one deployment. When the deployment is gone, the key gets nothing.
    const ask = (key: string) => fetch(`${serviceOrigin()}${APP_SERVICE_PATHS.tool}`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ slug: 'github', tool: 'request', input: { path: '/x' } }) })
    expect((await ask('sak_' + 'x'.repeat(43))).status).toBe(401)
    const key = appKeyOf(connected.app.id)
    expect((await ask(key)).status).toBe(200)
    await deployments.unpublish(owner, connected.app.id)
    expect((await ask(key)).status).toBe(401)
    expect(await deployments.view(owner, connected.app.id)).toBeNull()
  })

  test('the owner makes a new link or makes the app public, and a new secret starts the container again on the same data', async () => {
    // WHY (§7): the link is how the owner shares a private app, so they must
    // be able to take it back. WHY (decision 14): a secret is an env var of
    // the container, so a new value needs a new container, and the data stays.
    if (!hasRuntimeBundle) return
    const { apps, deployments, platform } = await solus()
    const { app } = await ship(apps, project(NOTES))
    await apps.secretSet(owner, app.id, 'token', 'first')
    const first = (await deployments.publish(owner, { appId: app.id })).deployment
    const browser = await visit(first)
    await browser.call('add', { text: 'kept' })
    expect((await browser.call('whoAndWhat')).value).toEqual({ caller: { kind: 'ui', role: 'editor' }, token: 'first' })

    const relinked = (await deployments.publish(owner, { appId: app.id, newLink: true })).deployment
    expect(relinked.link).not.toBe(first.link)
    expect((await browser.call('list')).status).toBe(401)
    expect((await visit(relinked, first.link)).entered).toBe(401)
    expect(platform.runs).toBe(1)

    await apps.secretSet(owner, app.id, 'token', 'second')
    const again = (await deployments.publish(owner, { appId: app.id, access: 'public', role: 'viewer' })).deployment
    expect(platform.runs).toBe(2)
    expect(again.link).toBe(again.address)
    // A publish that names no access keeps it: a new version must not make a public app private, or the reverse.
    expect((await deployments.publish(owner, { appId: app.id })).deployment).toMatchObject({ access: 'public', role: 'viewer' })
    // Public: a browser with no link reads, and with the viewer role it does not write.
    const anyone = await visit(again)
    expect((await anyone.call('whoAndWhat')).value).toEqual({ caller: { kind: 'ui', role: 'viewer' }, token: 'second' })
    expect((await anyone.call('list')).value).toEqual([{ id: 1, text: 'kept' }])
    expect((await anyone.call('add', { text: 'no' })).ok).toBe(false)
  })

  test('an exported image holds one version and runs with no Solus: its access is in its env vars', async () => {
    // WHY (§8.4): an adapter is a convenience, not a condition. A person can
    // run the app on a platform that Solus does not know, with no Solus at all.
    if (!hasRuntimeBundle) return
    const { apps, deployments } = await solus()
    const { app } = await ship(apps, project(NOTES))
    const folder = mkdtempSync(join(tmpdir(), 'solus-app-export-'))
    const exported = await deployments.exportImage(owner, app.id, folder)
    expect(exported).toMatchObject({ version: 1, env: [] })
    expect(readFileSync(join(folder, 'Dockerfile'), 'utf8')).toContain('FROM solus-apps-runtime:test')
    expect(readFileSync(join(folder, 'README.md'), 'utf8')).toContain('SOLUS_APP_LINK_SECRET')

    // What the image does when it starts: the runtime with the version file, and no Solus and no key.
    const volume = mkdtempSync(join(tmpdir(), 'solus-app-volume-'))
    const child = spawn('node', [RUNTIME_BUNDLE], { env: { PATH: process.env.PATH, SOLUS_DATA_DIR: volume, PORT: '0', SOLUS_APP_VERSION_FILE: join(folder, 'version.json'), SOLUS_APP_ACCESS: 'public' }, stdio: ['ignore', 'pipe', 'pipe'] })
    cleanups.push(async () => {
      await new Promise<void>((done) => {
        child.once('exit', () => done())
        child.kill('SIGTERM')
      })
      rmSync(volume, { recursive: true, force: true })
      rmSync(folder, { recursive: true, force: true })
    })
    const port = await new Promise<number>((done, fail) => {
      createInterface({ input: child.stdout! }).on('line', (line) => {
        const match = /listens on port (\d+)/.exec(line)
        if (match) done(Number(match[1]))
      })
      child.once('exit', () => fail(new Error('The runtime process ended before it listened.')))
    })
    const response = await fetch(`http://127.0.0.1:${port}${APP_VISITOR_PATHS.call}`, { method: 'POST', headers: { 'content-type': 'application/json', [APP_VISITOR_HEADER]: '1' }, body: JSON.stringify({ name: appOperationCallName('add'), argumentsJson: JSON.stringify({ text: 'with no Solus' }) }) })
    expect(await response.json()).toEqual({ ok: true, value: { id: 1, text: 'with no Solus' } })
  })

  test('the owner publishes an app to a connected host: the container runs there, and the app, its key, and its connections stay in its Solus', async () => {
    // WHY (§8.5): the owner has a machine that is always on, and works on
    // another. The copy must run on the first while the app stays on the
    // second. The Solus of the app does not reach a loopback port of the
    // other host, so each request of the management API goes through it.
    if (!hasRuntimeBundle) return
    const studio = containerHost()
    const { apps, deployments, platform } = await solus({ connectedHosts: studio.connectedHosts })
    const { app } = await ship(apps, project(CONNECTED))
    expect((await deployments.publishPlaces(owner)).places).toContainEqual({ platform: 'docker', host: { id: 'studio', label: 'Studio' }, problem: null })

    const { deployment, active } = await deployments.publish(owner, { appId: app.id, hostId: 'Studio' })
    expect(active).toBe(true)
    expect(deployment).toMatchObject({ platform: 'docker', host: { id: 'studio', label: 'Studio', isReachable: true }, running: true, version: 1, status: { activeVersion: 1 } })
    // The other host ran the container, and this one ran none.
    expect([platform.runs, studio.platform.runs]).toEqual([0, 1])
    expect(await deployments.logs(owner, app.id, 50)).toContain('solus-apps-runtime')
    // The container reaches the Solus of the app for an app connection: the owner's connection never leaves that Solus.
    const browser = await visit(deployment)
    expect(await browser.call('ours')).toEqual({ ok: true, value: [{ number: 7 }] })

    // A publish to another place is refused: the data of the copy is on the first one.
    await expect(deployments.publish(owner, { appId: app.id, hostId: null })).rejects.toThrow('This app is published on Studio')
    // A publish that names no place sends the version to the place the copy has.
    expect(await deployments.publish(owner, { appId: app.id })).toMatchObject({ active: true, deployment: { host: { id: 'studio' } } })

    // The other host does not answer: the section says so, and Unpublish keeps the record, because the container still runs there.
    studio.reach.isReachable = false
    expect(await deployments.view(owner, app.id)).toMatchObject({ host: { isReachable: false }, running: false, status: null })
    await expect(deployments.unpublish(owner, app.id)).rejects.toThrow('Studio is not connected')
    expect(await deployments.view(owner, app.id)).not.toBeNull()

    studio.reach.isReachable = true
    await deployments.unpublish(owner, app.id)
    expect(await deployments.view(owner, app.id)).toBeNull()
    expect(await studio.platform.status(app.id)).toEqual({ exists: false, running: false })
  })

  test('a host runs a container only for its owner, and carries only the management API to it', async () => {
    // WHY: a container is code that runs on the host. A member of the host, or a request for another path of the runtime, gets nothing.
    if (!hasRuntimeBundle) return
    const studio = containerHost()
    const spec = { appId: 'app-of-another-solus', slug: 'notes', env: { SOLUS_APP_KEY: `sak_${'k'.repeat(43)}`, SOLUS_URL: '' }, tailscaleAddress: false }
    await expect(studio.containers.run(member.principal, spec)).rejects.toThrow('Only the owner of this host')
    await expect(studio.containers.manage(member.principal, { appId: spec.appId, method: 'GET', path: '/_solus/v1/health', signature: null, body: null })).rejects.toThrow('Only the owner of this host')
    expect(studio.platform.runs).toBe(0)

    await studio.containers.run(owner.principal, spec)
    expect((await studio.containers.manage(owner.principal, { appId: spec.appId, method: 'GET', path: '/_solus/v1/health', signature: null, body: null })).status).toBe(200)
    // A request with no signature of the app's Solus is the runtime's to refuse: the host is a pipe.
    expect((await studio.containers.manage(owner.principal, { appId: spec.appId, method: 'GET', path: '/_solus/v1/status', signature: null, body: null })).status).toBe(401)
    expect(appContainerManageRequestSchema.safeParse({ appId: spec.appId, method: 'POST', path: '/_solus/app/call', signature: null, body: '{}' }).success).toBe(false)
  })

  test('the owner names the people who open the app: Solus Cloud gets the address and the list, and the copy sends a visitor there', async () => {
    // WHY (§7.3): the list is the owner's, and it must be where a sign-in is
    // decided. The copy holds no list: it holds only where to send a visitor.
    if (!hasRuntimeBundle) return
    const cloud = signInCloud()
    const { apps, deployments } = await solus({ signIn: cloud.signIn })
    const { app } = await ship(apps, project(NOTES))
    const people: AppAccessSubject[] = [{ subject: { kind: 'user', id: 'bob' }, role: 'viewer' }, { subject: { kind: 'team', id: 'team_design' }, role: 'editor' }]

    const { deployment } = await deployments.publish(owner, { appId: app.id, access: 'people', subjects: people })
    expect(deployment).toMatchObject({ access: 'people', subjects: people })
    // There is no link to give: the address is what a person opens.
    expect(deployment.link).toBe(deployment.address)
    expect(cloud.calls).toEqual([{ kind: 'set', appId: app.id, slug: 'notes', address: deployment.address, subjects: people }])
    const closed = await (await visit(deployment)).page()
    expect(closed.status).toBe(401)
    expect(await closed.text()).toContain('Sign in with Solus')

    // A publish of a new version names no access: the list stays, and Solus Cloud has it again.
    expect((await deployments.publish(owner, { appId: app.id })).deployment).toMatchObject({ access: 'people', subjects: people })
    expect(cloud.calls.at(-1)).toMatchObject({ kind: 'set', subjects: people })

    // With a link, no person signs in to the copy: Solus Cloud forgets the list. The Solus of the app keeps it for a change back.
    const linked = (await deployments.publish(owner, { appId: app.id, access: 'link' })).deployment
    expect(cloud.calls.at(-1)).toEqual({ kind: 'remove', appId: app.id })
    expect(linked.subjects).toEqual(people)
    expect(await (await (await visit(linked)).page()).status).toBe(200)
    expect((await deployments.publish(owner, { appId: app.id, access: 'people' })).deployment.subjects).toEqual(people)

    await deployments.unpublish(owner, app.id)
    expect(cloud.calls.at(-1)).toEqual({ kind: 'remove', appId: app.id })
  })

  test('people can be named only when the owner is signed in to Solus on the host, and the first publish leaves nothing when it is refused', async () => {
    if (!hasRuntimeBundle) return
    const cloud = signInCloud()
    cloud.state.isSignedIn = false
    const { apps, deployments, platform } = await solus({ signIn: cloud.signIn })
    const { app } = await ship(apps, project(NOTES))
    await expect(deployments.publish(owner, { appId: app.id, access: 'people', subjects: [] })).rejects.toThrow('Sign in to Solus on the host of the app')
    expect([platform.runs, await deployments.view(owner, app.id)]).toEqual([0, null])
    expect((await deployments.publishPlaces(owner)).canNamePeople).toBe(false)
  })

  test('the host says which places it has before a publish, and only its owner asks', async () => {
    // WHY: the section offers a place only with what the host said of it, so the owner sees what is missing before they publish.
    if (!hasRuntimeBundle) return
    const studio = containerHost()
    const { deployments } = await solus({ connectedHosts: studio.connectedHosts, hasTailscaleKey: true })
    expect(await deployments.publishPlaces(owner)).toEqual({
      places: [{ platform: 'docker', host: null, problem: null }, { platform: 'docker', host: { id: 'studio', label: 'Studio' }, problem: null }],
      hasTailscaleKey: true,
      canNamePeople: false,
    })
    await expect(deployments.publishPlaces(member)).rejects.toThrow('Only the owner of this host')
  })

  test('the copy takes the webhooks of the app at its own address, with the signing secret the webhook has in Solus', async () => {
    // WHY (§7.4): the other service signs with one secret for the app and for its copy, and the owner copies one more URL.
    if (!hasRuntimeBundle) return
    const { apps, deployments, platform } = await solus()
    const { app } = await ship(apps, project(HOOKED))
    // The webhook owner of a host keeps the secret of each webhook an app declares; this test host has none, so the test writes one.
    const { saveApp, loadApp } = await import('@solus/server/data/apps/app-store')
    const { writeWebhookSecrets } = await import('@solus/server/data/webhooks/webhook-secrets')
    const { ANY_ORGANIZATION } = await import('@solus/server/admission/principal')
    writeWebhookSecrets('webhook-1', { token: 'url-token', secret: Buffer.from('hook-secret').toString('base64') })
    const record = await loadApp(ANY_ORGANIZATION, app.id)
    if (!record) throw new Error('The app has no record.')
    await saveApp({ ...record, webhookIds: { pushed: 'webhook-1' } })

    const { deployment } = await deployments.publish(owner, { appId: app.id })
    expect(deployment.webhooks).toEqual([{ name: 'pushed', url: `${deployment.address}/_solus/hooks/pushed` }])
    expect(platform.envs.get(app.id)?.SOLUS_APP_WEBHOOK_SECRET_PUSHED).toBe(Buffer.from('hook-secret').toString('base64'))
    const send = (token: string) => fetch(deployment.webhooks[0]?.url ?? '', { method: 'POST', headers: { 'x-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'from a hook' }) })
    expect((await send('wrong')).status).toBe(401)
    expect((await send('hook-secret')).status).toBe(200)
    expect((await (await visit(deployment)).call('list')).value).toEqual([{ id: 1, text: 'from a hook' }])
  })

  test('a model call of the copy runs in Solus with the owner\'s model, and the operation it uses as a tool runs in the copy', async () => {
    // WHY (§5.2): the copy has no model account. Solus runs the call, and the
    // model must read the data of the copy, not the data of the app in Solus.
    if (!hasRuntimeBundle) return
    const model = scriptedModel()
    const { apps, deployments } = await solus({ dispatcher: model.dispatcher })
    const { app } = await ship(apps, project(ANALYST))
    await call(apps, app.id, appOperationCallName('add'), { text: 'in Solus' })
    const browser = await visit((await deployments.publish(owner, { appId: app.id })).deployment)
    await browser.call('add', { text: 'in the copy' })

    const started = await browser.call('ask')
    expect(started.ok).toBe(true)
    const ended = await eventuallyDone(() => browser.model('get', started.value.id))
    expect(ended).toMatchObject({ status: 'done', model: 'default-model' })
    // The tool read the one note of the copy.
    expect(ended.result).toBe('The model read: [{"id":1,"text":"in the copy"}]')
    expect(model.prompts).toEqual([expect.stringContaining('Count the notes.')])
  })

  test('an app that is deleted leaves no deployment that runs', async () => {
    // WHY: a container of an app that is gone would run with a key of nothing, at an address somebody may still have.
    if (!hasRuntimeBundle) return
    const { apps, deployments, platform } = await solus()
    const { app } = await ship(apps, project(NOTES))
    await deployments.publish(owner, { appId: app.id })
    expect(await platform.status(app.id)).toEqual({ exists: true, running: true })
    await apps.delete(owner, app.id)
    expect(await platform.status(app.id)).toEqual({ exists: false, running: false })
    void by
  })
})

/** NOTES with a mutation that takes a webhook's request as its input. */
const HOOKED: AppProjectFiles = {
  ...NOTES,
  app: NOTES.app
    .replace("run: 'add' } },\n})", "run: 'received' } },\n})")
    .replace('  operations: {', `  operations: {
    received: mutation({ input: z.object({ headers: z.record(z.string(), z.string()), query: z.record(z.string(), z.string()), body: z.object({ text: z.string() }) }) }, (ctx, input) =>
      ctx.sql.exec('INSERT INTO notes (text) VALUES (?) RETURNING id, text', input.body.text).one()),`),
}

/** An app that asks a model, which reads the notes with the `list` operation. */
const ANALYST: AppProjectFiles = {
  app: `import { defineApp, query, mutation } from '@solus/app/backend'
import { z } from 'zod'
export default defineApp({
  name: 'Analyst',
  config: { analyst: { type: 'model', label: 'Analyst' } },
  operations: {
    list: query({ description: 'Every note.' }, (ctx) => ctx.sql.exec('SELECT id, text FROM notes ORDER BY id').all()),
    add: mutation({ input: z.object({ text: z.string() }) }, (ctx, input) => ctx.sql.exec('INSERT INTO notes (text) VALUES (?) RETURNING id, text', input.text).one()),
    ask: mutation({}, (ctx) => ctx.models.start('analyst', { prompt: 'Count the notes.', tools: ['list'] })),
  },
})`,
  migrations: { '0001_notes.sql': 'CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL);' },
  ui: '<!doctype html><title>Analyst</title><div id="root"></div>',
}

/** Solus Cloud for the sign-in of a copy: it records what the Solus of the app tells it. */
function signInCloud() {
  const calls: ({ kind: 'set'; appId: string; slug: string; address: string; subjects: readonly AppAccessSubject[] } | { kind: 'remove'; appId: string })[] = []
  const state = { isSignedIn: true }
  const signIn: SignIn = {
    isSignedIn: () => state.isSignedIn,
    setAccess: async (appId, access) => {
      calls.push({ kind: 'set', appId, ...access })
      return { origin: 'https://app.example.test', app: 'copy-1' }
    },
    removeAccess: async (appId) => void calls.push({ kind: 'remove', appId }),
  }
  return { calls, state, signIn }
}

/** A model that uses each tool it has once and then answers with what the tools gave. */
function scriptedModel() {
  const prompts: string[] = []
  const dispatcher: AgentDispatcher = {
    runAgent(request) {
      prompts.push(request.prompt)
      const done = (async () => {
        const texts: string[] = []
        // SAFETY: the tools of a model call read nothing of the context.
        for (const tool of request.tools ?? []) texts.push((await tool.execute({}, {} as never)).text)
        return { sessionId: null, output: `The model read: ${texts.map((text) => JSON.stringify(JSON.parse(text))).join(' ')}`, toolCallCount: texts.length, permissionDenials: [], exitCode: 0, signal: null }
      })()
      // SAFETY: the model calls use only `done` and `cancel` of a run.
      return { done, cancel: () => {}, sessionId: Promise.resolve(null), handle: {} } as never
    },
  }
  return { prompts, dispatcher }
}

/** Reads a model call until it ended, as the page of an app does. */
async function eventuallyDone(read: () => Promise<{ ok?: boolean; value?: { status: string; model: string | null; result: unknown } }>) {
  for (let tries = 0; tries < 200; tries += 1) {
    const view = (await read()).value
    if (view && view.status !== 'queued' && view.status !== 'running') return view
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('The model call did not end.')
}

/**
 * Another host of the owner, as the Solus of an app reaches it: its
 * container service, and the API a connection to it has. Each request is
 * decoded by its schema, as the RPC handler of that host does.
 */
function containerHost() {
  const platform = new ProcessPlatform()
  const containers = new hostedModule.HostedAppContainers(platform)
  cleanups.push(() => platform.dispose())
  /** The connection to the host: a test takes it away and gives it back. */
  const reach = { isReachable: true }
  const reached = <T,>(answer: () => Promise<T>): Promise<T> => (reach.isReachable ? answer() : Promise.reject(new Error('Studio is not connected.')))
  const api: ContainerHostApi = {
    appContainerRun: (request) => reached(() => containers.run(owner.principal, appContainerRunRequestSchema.parse(request))),
    appContainerStatus: (request) => reached(() => containers.status(owner.principal, appContainerRequestSchema.parse(request))),
    appContainerLogs: (request) => reached(() => containers.logs(owner.principal, appContainerLogsRequestSchema.parse(request))),
    appContainerRemove: (request) => reached(() => containers.remove(owner.principal, appContainerRequestSchema.parse(request))),
    appContainerManage: (request) => reached(() => containers.manage(owner.principal, appContainerManageRequestSchema.parse(request))),
  }
  const connectedHosts: ConnectedHosts = {
    list: async () => [{ id: 'studio', label: 'Studio' }],
    connect: async (hostId) => {
      // A person names a host by its id or by its name.
      if (hostId.toLowerCase() !== 'studio') throw new Error(`You do not reach a host "${hostId}" from here.`)
      return { id: 'studio', label: 'Studio', platform: new connectedHostModule.ConnectedHostPlatform('Studio', api) }
    },
  }
  return { platform, containers, reach, connectedHosts }
}

/** The app key of a deployment, as the test host's secret store holds it. */
function appKeyOf(appId: string): string {
  const { secretStore } = require('@solus/server/platform/secrets') as typeof import('@solus/server/platform/secrets')
  const { z } = require('zod') as typeof import('zod')
  return secretStore().loadJson(`app-deployment-${appId}`, join(dataDir, 'app-secrets', `deployment-${appId}.bin`), z.object({ key: z.string() }))!.key
}
