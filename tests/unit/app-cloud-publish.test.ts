import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { appOperationCallName } from '@solus/contracts/apps'
import { APP_VISITOR_HEADER, APP_VISITOR_PATHS, type AppDeploymentView } from '@solus/contracts/app-deployments'
import type { AppProjectFiles } from './helpers/app-project'
import { host, installAppsHost, owner, project, ship } from './helpers/apps-host'

type DeploymentsModule = typeof import('@solus/server/apps/deployments/app-deployments')
type CloudModule = typeof import('@solus/server/apps/deployments/solus-cloud-platform')
type MachinesModule = typeof import('@solus/server/apps/deployments/cloud-machines')

/**
 * A publish to Solus Cloud (docs/plans/app-deploy.md §8.3), against a real
 * app Worker on Cloudflare (`solus-cloud/app-worker`). It runs only when the
 * env names one:
 *
 *   SOLUS_CLOUD_APPS_URL    the origin of the Worker
 *   SOLUS_CLOUD_APPS_TOKEN  its management token
 *   SOLUS_CLOUD_APPS_NAME   the name of the app's machine (`trial` on the trial Worker)
 *
 * It makes one deployment there and removes it.
 */

const url = process.env.SOLUS_CLOUD_APPS_URL
const token = process.env.SOLUS_CLOUD_APPS_TOKEN
const name = process.env.SOLUS_CLOUD_APPS_NAME ?? 'trial'
const describeWithCloud = url && token ? describe : describe.skip

const NOTES: AppProjectFiles = {
  app: `import { defineApp, query, mutation } from '@solus/app/backend'
import { z } from 'zod'
export default defineApp({
  name: 'Notes',
  secrets: { token: { label: 'API token' } },
  operations: {
    list: query({}, (ctx) => ctx.sql.exec('SELECT id, text FROM notes ORDER BY id').all()),
    add: mutation({ input: z.object({ text: z.string() }) }, (ctx, input) => ctx.sql.exec('INSERT INTO notes (text) VALUES (?) RETURNING id, text', input.text).one()),
    token: query({}, (ctx) => ctx.secrets.token ?? null),
  },
})`,
  migrations: { '0001_notes.sql': 'CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL);' },
  ui: '<!doctype html><html><head><title>Notes</title></head><body><div id="root"></div></body></html>',
}

let deploymentsModule: DeploymentsModule
let cloudModule: CloudModule
let machinesModule: MachinesModule
let cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
installAppsHost()
beforeAll(async () => {
  deploymentsModule = await import('@solus/server/apps/deployments/app-deployments')
  cloudModule = await import('@solus/server/apps/deployments/solus-cloud-platform')
  machinesModule = await import('@solus/server/apps/deployments/cloud-machines')
})

/** A browser that opens the link of a deployment. */
async function visit(deployment: AppDeploymentView) {
  const [address = '', secret = ''] = (deployment.link ?? '').split('/#')
  const base = { 'content-type': 'application/json', [APP_VISITOR_HEADER]: '1' }
  const entered = await fetch(`${address}${APP_VISITOR_PATHS.enter}`, { method: 'POST', headers: base, body: JSON.stringify({ secret }) })
  const cookie = entered.headers.get('set-cookie') ?? ''
  return {
    cookie,
    page: () => fetch(address, { headers: { cookie: cookie.split(';')[0] ?? '' } }),
    call: async (operation: string, input: object = {}) => {
      const response = await fetch(`${address}${APP_VISITOR_PATHS.call}`, { method: 'POST', headers: { ...base, cookie: cookie.split(';')[0] ?? '' }, body: JSON.stringify({ name: appOperationCallName(operation), argumentsJson: JSON.stringify(input) }) })
      return response.json()
    },
  }
}

describeWithCloud('a publish to Solus Cloud', () => {
  test('the app runs in a container on Cloudflare at an HTTPS address, and its data comes back after the container slept', async () => {
    // WHY (§8.3): the disk of a Cloudflare container is gone when the
    // container ends. The Worker saves /data to R2 before a sleep and puts it
    // back before the runtime opens it; without that, each sleep would empty
    // the app of a person who is not there to see it.
    const { apps } = await host()
    const platform = new cloudModule.SolusCloudPlatform(machinesModule.workerMachines({ url: url ?? '', token: token ?? '', name: () => name }))
    const deployments = new deploymentsModule.AppDeployments(apps, { runtimeImage: () => 'solus-apps-runtime:test', platforms: [platform], solusUrl: () => '' })
    apps.addLifecyclePart(deployments)
    const { app } = await ship(apps, project(NOTES))
    cleanups.push(() => platform.remove(app.id))
    await apps.secretSet(owner, app.id, 'token', 'cloud-secret')

    const published = await deployments.publish(owner, { appId: app.id, platform: 'solus-cloud' })
    expect(published).toMatchObject({ active: true, deployment: { platform: 'solus-cloud', version: 1, status: { activeVersion: 1, access: 'link' } } })
    expect(published.deployment.address).toMatch(/^https:\/\//)

    const browser = await visit(published.deployment)
    // The Worker ends TLS, so the session cookie is for HTTPS only.
    expect(browser.cookie).toContain('Secure')
    expect((await browser.page()).status).toBe(200)
    expect(await browser.call('add', { text: 'kept over a sleep' })).toEqual({ ok: true, value: { id: 1, text: 'kept over a sleep' } })
    expect(await browser.call('token')).toEqual({ ok: true, value: 'cloud-secret' })
    // A stranger at the address gets the way in, not the app.
    expect((await fetch(published.deployment.address ?? '')).status).toBe(401)

    // The container ends, and the next request starts a new one with the data and the link of before.
    await platform.stop(app.id)
    expect(await browser.call('list')).toEqual({ ok: true, value: [{ id: 1, text: 'kept over a sleep' }] })

    await deployments.unpublish(owner, app.id)
    expect(await platform.status(app.id)).toEqual({ exists: false, running: false })
  }, 600_000)

  test('a cloud app that sleeps starts by itself for its next schedule', async () => {
    // WHY (§8.3): a container ends when nobody uses the app. Without a start
    // for the next schedule, an app with a job for each night would run it
    // only when a person opens the app.
    const { apps } = await host()
    const platform = new cloudModule.SolusCloudPlatform(machinesModule.workerMachines({ url: url ?? '', token: token ?? '', name: () => name }))
    const deployments = new deploymentsModule.AppDeployments(apps, { runtimeImage: () => 'solus-apps-runtime:test', platforms: [platform], solusUrl: () => '' })
    apps.addLifecyclePart(deployments)
    const { app } = await ship(apps, project({ ...NOTES, app: NOTES.app.replace('  operations: {', "  schedules: { tick: { every: { minutes: 1 }, run: 'add', input: { text: 'tick' } } },\n  operations: {") }))
    cleanups.push(() => platform.remove(app.id))
    const published = await deployments.publish(owner, { appId: app.id, platform: 'solus-cloud' })

    // What the Worker says of the machine. This read starts no container.
    const machine = async () => {
      const response = await fetch(`${url}/_cloud/v1/apps/${name}`, { headers: { authorization: `Bearer ${token}` } })
      const state: { running?: boolean } = await response.json()
      return state.running === true
    }
    await platform.stop(app.id)
    expect(await machine()).toBe(false)
    // The schedule is due in a minute at most, and the container starts thirty seconds before that.
    const deadline = Date.now() + 150_000
    while (!(await machine()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 3000))
    expect(await machine()).toBe(true)

    // The job ran with nobody there: its row is in the data that came back from the save.
    const browser = await visit(published.deployment)
    const ticked = async () => (await browser.call('list')).value.some((row: { text: string }) => row.text === 'tick')
    const ran = Date.now() + 120_000
    while (!(await ticked()) && Date.now() < ran) await new Promise((resolve) => setTimeout(resolve, 3000))
    expect(await ticked()).toBe(true)
    await deployments.unpublish(owner, app.id)
  }, 600_000)
})
