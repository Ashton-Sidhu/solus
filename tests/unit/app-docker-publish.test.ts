import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { appOperationCallName } from '@solus/contracts/apps'
import { APP_VISITOR_HEADER, APP_VISITOR_PATHS, type AppDeploymentView } from '@solus/contracts/app-deployments'
import type { AppProjectFiles } from './helpers/app-project'
import { connectionCalls, host, installAppsHost, owner, project, ship } from './helpers/apps-host'

type DeploymentsModule = typeof import('@solus/server/apps/deployments/app-deployments')
type DockerModule = typeof import('@solus/server/apps/deployments/docker-platform')
type ServiceModule = typeof import('@solus/server/apps/deployments/app-service-api')
type ConnectedHostModule = typeof import('@solus/server/apps/deployments/connected-host-platform')
type HostedModule = typeof import('@solus/server/apps/deployments/hosted-app-containers')

/**
 * A publish to real Docker (docs/plans/app-deploy.md §8.1): the image is
 * built from this checkout, and the docker platform runs a real container of
 * it. A machine with no Docker engine skips this file; the same flow runs
 * with a process in place of the container in `app-deployments.test.ts`.
 */

const repoRoot = resolve(import.meta.dir, '../..')
const IMAGE = 'solus-apps-runtime:test'

function docker(args: string[]): { ok: boolean; out: string } {
  const run = spawnSync('docker', args, { encoding: 'utf8' })
  return { ok: run.status === 0, out: `${run.stdout}${run.stderr}`.trim() }
}

const hasDocker = docker(['version', '--format', '{{.Server.Version}}']).ok
const describeWithDocker = hasDocker ? describe : describe.skip

const NOTES: AppProjectFiles = {
  app: `import { defineApp, query, mutation } from '@solus/app/backend'
import { z } from 'zod'
export default defineApp({
  name: 'Notes',
  secrets: { token: { label: 'API token' } },
  appIntegrations: ['github'],
  operations: {
    list: query({}, (ctx) => ctx.sql.exec('SELECT id, text FROM notes ORDER BY id').all()),
    add: mutation({ input: z.object({ text: z.string() }) }, (ctx, input) => ctx.sql.exec('INSERT INTO notes (text) VALUES (?) RETURNING id, text', input.text).one()),
    token: query({}, (ctx) => ctx.secrets.token ?? null),
    pulls: query({}, (ctx) => ctx.tools.github.request({ path: '/repos/acme/web/pulls' })),
  },
})`,
  migrations: { '0001_notes.sql': 'CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL);' },
  ui: '<!doctype html><html><head><title>Notes</title></head><body><div id="root"></div></body></html>',
}

let deploymentsModule: DeploymentsModule
let dockerModule: DockerModule
let serviceModule: ServiceModule
let connectedHostModule: ConnectedHostModule
let hostedModule: HostedModule
let cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
installAppsHost()
beforeAll(async () => {
  if (!hasDocker) return
  // The image under test is the one of this checkout.
  expect(spawnSync('bun', ['scripts/build-apps-runtime.ts'], { cwd: repoRoot }).status).toBe(0)
  const built = docker(['build', '--quiet', '--tag', IMAGE, resolve(repoRoot, 'dist', 'apps-runtime')])
  if (!built.ok) throw new Error(`The image did not build: ${built.out}`)
  deploymentsModule = await import('@solus/server/apps/deployments/app-deployments')
  dockerModule = await import('@solus/server/apps/deployments/docker-platform')
  serviceModule = await import('@solus/server/apps/deployments/app-service-api')
  connectedHostModule = await import('@solus/server/apps/deployments/connected-host-platform')
  hostedModule = await import('@solus/server/apps/deployments/hosted-app-containers')
}, 300_000)

/** A browser that opens the link of a deployment. */
async function visit(deployment: AppDeploymentView) {
  const [address = '', secret = ''] = (deployment.link ?? '').split('/#')
  const base = { 'content-type': 'application/json', [APP_VISITOR_HEADER]: '1' }
  const entered = await fetch(`${address}${APP_VISITOR_PATHS.enter}`, { method: 'POST', headers: base, body: JSON.stringify({ secret }) })
  const cookie = entered.headers.get('set-cookie')?.split(';')[0] ?? ''
  return {
    page: () => fetch(address, { headers: { cookie } }),
    call: async (operation: string, input: object = {}) => {
      const response = await fetch(`${address}${APP_VISITOR_PATHS.call}`, { method: 'POST', headers: { ...base, cookie }, body: JSON.stringify({ name: appOperationCallName(operation), argumentsJson: JSON.stringify(input) }) })
      return response.json()
    },
  }
}

describeWithDocker('a publish to Docker', () => {
  test('the app runs in a container of the runtime image, keeps its data in a volume, reaches Solus for an app connection, and leaves nothing when it is unpublished', async () => {
    // WHY: each other test of a deployment runs the runtime as a process. This
    // one proves the image itself: the runtime starts in it as its own user,
    // the runner starts under it, the volume holds the data over a new
    // container, and the container reaches the service API of its Solus.
    let serviceOrigin = ''
    const { apps, signals } = await host()
    const platform = new dockerModule.DockerPlatform({ image: () => IMAGE })
    const deployments = new deploymentsModule.AppDeployments(apps, { runtimeImage: () => 'solus-apps-runtime:test', platforms: [platform], solusUrl: () => serviceOrigin })
    apps.addLifecyclePart(deployments)
    const service = new serviceModule.AppServiceApi({ deployments, apps, signals })
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
    // Docker reaches the host's loopback listeners by this name on Docker Desktop; on Linux the listener must be on the bridge.
    await new Promise<void>((done) => server.listen(0, '0.0.0.0', done))
    // SAFETY: a listener on a TCP port answers an AddressInfo.
    serviceOrigin = `http://host.docker.internal:${(server.address() as AddressInfo).port}`

    const { app } = await ship(apps, project(NOTES))
    const container = `solus-app-${app.id}`
    cleanups.push(async () => {
      server.closeAllConnections()
      server.close()
      docker(['rm', '--force', container])
      docker(['volume', 'rm', '--force', `${container}-data`])
    })
    await apps.secretSet(owner, app.id, 'token', 'first')

    const first = await deployments.publish(owner, { appId: app.id })
    expect(first).toMatchObject({ active: true, deployment: { running: true, version: 1, status: { activeVersion: 1 } } })
    // The management port is on the loopback interface of the host only.
    expect(docker(['port', container, '8080/tcp']).out).toMatch(/^127\.0\.0\.1:\d+$/)
    // The runtime is not root in its container.
    expect(docker(['exec', container, 'id', '-un']).out).toBe('node')

    const browser = await visit(first.deployment)
    expect((await browser.page()).status).toBe(200)
    expect(await browser.call('add', { text: 'in the volume' })).toEqual({ ok: true, value: { id: 1, text: 'in the volume' } })
    expect(await browser.call('token')).toEqual({ ok: true, value: 'first' })
    expect(await browser.call('pulls')).toEqual({ ok: true, value: [{ number: 7 }] })
    expect(connectionCalls).toEqual([{ provider: 'github', input: { path: '/repos/acme/web/pulls' } }])

    // A new secret is a new container on the same volume.
    await apps.secretSet(owner, app.id, 'token', 'second')
    const second = await deployments.publish(owner, { appId: app.id })
    expect(second.active).toBe(true)
    const again = await visit(second.deployment)
    expect(await again.call('token')).toEqual({ ok: true, value: 'second' })
    expect(await again.call('list')).toEqual({ ok: true, value: [{ id: 1, text: 'in the volume' }] })
    expect(await deployments.logs(owner, app.id, 200)).toContain('solus-apps-runtime')

    await deployments.unpublish(owner, app.id)
    expect(docker(['inspect', container]).ok).toBe(false)
    expect(docker(['volume', 'inspect', `${container}-data`]).ok).toBe(false)
  }, 180_000)

  test('a connected host runs the container on its own Docker, under a name of its own, and carries the management API to it', async () => {
    // WHY (§8.5): the Solus of the app does not reach a loopback port of the
    // other host. This proves, on a real engine, that the other host finds the
    // port of the container it ran and that a version arrives through it.
    const { apps } = await host()
    const containers = new hostedModule.HostedAppContainers(new dockerModule.DockerPlatform({ image: () => IMAGE, namePrefix: 'solus-hosted-app-' }))
    const studio = new connectedHostModule.ConnectedHostPlatform('Studio', {
      appContainerRun: (request) => containers.run(owner.principal, request),
      appContainerStatus: (request) => containers.status(owner.principal, request),
      appContainerLogs: (request) => containers.logs(owner.principal, request),
      appContainerRemove: (request) => containers.remove(owner.principal, request),
      appContainerManage: (request) => containers.manage(owner.principal, request),
    })
    const deployments = new deploymentsModule.AppDeployments(apps, {
      runtimeImage: () => IMAGE,
      platforms: [],
      solusUrl: () => '',
      connectedHosts: { list: async () => [{ id: 'studio', label: 'Studio' }], connect: async () => ({ id: 'studio', label: 'Studio', platform: studio }) },
    })
    apps.addLifecyclePart(deployments)
    const { app } = await ship(apps, project({ ...NOTES, app: NOTES.app.replace("  appIntegrations: ['github'],\n", '').replace("    pulls: query({}, (ctx) => ctx.tools.github.request({ path: '/repos/acme/web/pulls' })),\n", '') }))
    const container = `solus-hosted-app-${app.id}`
    cleanups.push(() => {
      docker(['rm', '--force', container])
      docker(['volume', 'rm', '--force', `${container}-data`])
    })

    const published = await deployments.publish(owner, { appId: app.id, hostId: 'studio' })
    expect(published).toMatchObject({ active: true, deployment: { host: { id: 'studio', isReachable: true }, running: true, status: { activeVersion: 1 } } })
    // The container has the name of a hosted one: a deployment of the other host's own app cannot have it.
    expect(docker(['inspect', '--format', '{{.State.Running}}', container]).out).toBe('true')
    expect(docker(['inspect', `solus-app-${app.id}`]).ok).toBe(false)
    const browser = await visit(published.deployment)
    expect(await browser.call('add', { text: 'on the other host' })).toEqual({ ok: true, value: { id: 1, text: 'on the other host' } })

    await deployments.unpublish(owner, app.id)
    expect(docker(['inspect', container]).ok).toBe(false)
    expect(docker(['volume', 'inspect', `${container}-data`]).ok).toBe(false)
  }, 180_000)
})
