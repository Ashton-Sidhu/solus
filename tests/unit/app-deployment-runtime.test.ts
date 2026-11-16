import { afterEach, beforeAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  APP_MANAGEMENT_PATHS,
  APP_MANAGEMENT_SIGNATURE_HEADER,
  APP_VISITOR_HEADER,
  APP_VISITOR_PATHS,
  APP_WEBHOOK_PATH_PREFIX,
  appSignInEntryRequestSchema,
  type AppAccess,
  type AppSignInEntry,
  type AppVersionPush,
} from '@solus/contracts/app-deployments'
import { appOperationCallName } from '@solus/contracts/apps'
import { testAppBuilder, type AppProjectFiles } from './helpers/app-project'
import { NOTES, dataDir, describeWithNode, installAppsHost, project } from './helpers/apps-host'

type RuntimeModule = typeof import('@solus/server/apps/runtime/app-runtime')
type HttpModule = typeof import('@solus/server/apps/runtime/runtime-http')
type SignatureModule = typeof import('@solus/server/apps/runtime/management-signature')

/**
 * The runtime of a deployment (docs/plans/app-deploy.md §5.1, §5.3, §7): the
 * program of a `solus-apps-runtime` container, here as one process over a
 * real database, a real HTTP listener, and a real Node runner. Solus is this
 * test: it builds each version and sends it with a signed request. A visitor
 * is this test too: a browser at the address, with the link or without it.
 */

let runtimeModule: RuntimeModule
let httpModule: HttpModule
let signature: SignatureModule
let stops: (() => void)[] = []

afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})
installAppsHost()
beforeAll(async () => {
  runtimeModule = await import('@solus/server/apps/runtime/app-runtime')
  httpModule = await import('@solus/server/apps/runtime/runtime-http')
  signature = await import('@solus/server/apps/runtime/management-signature')
})

const APP_ID = 'a1b2c3d4-0000-4000-8000-000000000001'
const REVISION = 'a'.repeat(40)
const LINK_SECRET = 'L'.repeat(43)
const LINK: AppAccess = { mode: 'link', role: 'editor', linkSecret: LINK_SECRET }

interface Deployment {
  key: string
  origin: string
  restart(): Promise<Deployment>
}

/** One deployment: the runtime, and its listener on a port of its own. `fetchImpl` is how it reaches Solus Cloud for a sign-in. */
async function deployment(env: NodeJS.ProcessEnv = {}, key = signature.newAppKey(), fetchImpl?: typeof fetch): Promise<Deployment> {
  const runtime = new runtimeModule.AppRuntime({ release: 'test', env, runners: { node: 'node' }, fetchImpl })
  await runtime.start()
  const { server, port } = await httpModule.listenRuntime({ runtime, appKey: key }, 0, '127.0.0.1')
  const stop = (): void => {
    server.closeAllConnections()
    server.close()
    runtime.stop()
  }
  stops.push(stop)
  return {
    key,
    origin: `http://127.0.0.1:${port}`,
    restart: async () => {
      stops = stops.filter((entry) => entry !== stop)
      stop()
      return deployment(env, key, fetchImpl)
    },
  }
}

/** One management request, signed as Solus signs it. */
async function ask(target: Deployment, method: 'GET' | 'POST', path: string, body?: object, signWith = target.key, at = Date.now()) {
  const text = body === undefined ? '' : JSON.stringify(body)
  const response = await fetch(`${target.origin}${path}`, {
    method,
    headers: { [APP_MANAGEMENT_SIGNATURE_HEADER]: signature.signManagementRequest(signWith, { method, path, body: text }, at) },
    ...(body === undefined ? {} : { body: text }),
  })
  return { status: response.status, body: await response.json() }
}

/** What Solus sends for one version: the build of the project, as its own builder made it. */
async function built(files: AppProjectFiles, number: number, access: AppAccess | undefined = LINK): Promise<AppVersionPush> {
  const { build } = await testAppBuilder().buildProject(project(files))
  return { app: { id: APP_ID, slug: 'notes' }, number, sourceCommit: REVISION, message: `Version ${number}`, build, config: {}, access }
}

const push = (target: Deployment, version: AppVersionPush) => ask(target, 'POST', APP_MANAGEMENT_PATHS.versions, version)

/** A browser at the address of a deployment: it keeps the cookie that the deployment sets. */
function visitor(target: Deployment) {
  let cookie = ''
  const headers = () => ({ 'content-type': 'application/json', [APP_VISITOR_HEADER]: '1', ...(cookie ? { cookie } : {}) })
  return {
    /** Takes the cookies that a response of the deployment set, as a browser does. */
    keep: (response: Response) => {
      cookie = response.headers.getSetCookie().map((entry) => entry.split(';')[0] ?? '').filter((entry) => !entry.endsWith('=')).join('; ')
    },
    /** One navigation of the browser, which stops at a redirect so the test reads it. */
    go: (path: string) => fetch(`${target.origin}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} }),
    page: () => fetch(target.origin, { headers: cookie ? { cookie } : {} }),
    /** What the page of the app does with the secret in the fragment of the link. */
    enter: async (secret: string) => {
      const response = await fetch(`${target.origin}${APP_VISITOR_PATHS.enter}`, { method: 'POST', headers: headers(), body: JSON.stringify({ secret }) })
      cookie = response.headers.get('set-cookie')?.split(';')[0] ?? ''
      return response.status
    },
    call: async (operation: string, input: object = {}) => {
      const response = await fetch(`${target.origin}${APP_VISITOR_PATHS.call}`, { method: 'POST', headers: headers(), body: JSON.stringify({ name: appOperationCallName(operation), argumentsJson: JSON.stringify(input) }) })
      return { status: response.status, body: await response.json() }
    },
  }
}

/** A visitor who came in with the link. */
async function guest(target: Deployment) {
  const browser = visitor(target)
  expect(await browser.enter(LINK_SECRET)).toBe(200)
  return browser
}

describeWithNode('the runtime of a deployment', () => {
  test('a deployment runs a version that Solus built and sent, with no source and no build of its own', async () => {
    // WHY (decision 6): a public container must not hold source, npm, or a
    // compiler. The build stays in Solus, and the deployment runs what it got.
    const target = await deployment()
    expect((await ask(target, 'GET', APP_MANAGEMENT_PATHS.status)).body).toEqual({ runtime: { release: 'test', protocols: [2, 3, 4] }, activeVersion: null, calls24h: 0, failed24h: 0, access: null })

    expect((await push(target, await built(NOTES, 1))).body).toEqual({ version: 1, active: true, error: null })
    const browser = await guest(target)
    expect((await browser.call('add', { text: 'first' })).body).toEqual({ ok: true, value: { id: 1, text: 'first' } })
    expect((await browser.call('list')).body).toEqual({ ok: true, value: [{ id: 1, text: 'first' }] })
    expect((await ask(target, 'GET', APP_MANAGEMENT_PATHS.status)).body).toMatchObject({ activeVersion: 1, calls24h: 2, failed24h: 0, access: 'link' })
    // The build is a folder of the version's files. There is no repository to clone.
    expect(existsSync(join(dataDir, 'apps', 'builds'))).toBe(true)
    expect(existsSync(join(dataDir, 'apps', 'repositories'))).toBe(false)
  })

  test('a request that the Solus of the deployment did not sign changes nothing', async () => {
    // WHY (§5.3): the management API can replace the code that runs. Only the
    // holder of the app key may use it, and a recorded request must stop working.
    const target = await deployment()
    const version = await built(NOTES, 1)
    const unsigned = await fetch(`${target.origin}${APP_MANAGEMENT_PATHS.versions}`, { method: 'POST', body: JSON.stringify(version) })
    expect(unsigned.status).toBe(401)
    expect((await ask(target, 'POST', APP_MANAGEMENT_PATHS.versions, version, signature.newAppKey())).status).toBe(401)
    expect((await ask(target, 'POST', APP_MANAGEMENT_PATHS.versions, version, target.key, Date.now() - 10 * 60_000)).status).toBe(401)
    // A signature is for one request: the signature of a status read does not send a version.
    const forStatus = signature.signManagementRequest(target.key, { method: 'GET', path: APP_MANAGEMENT_PATHS.status, body: '' })
    const replayed = await fetch(`${target.origin}${APP_MANAGEMENT_PATHS.versions}`, { method: 'POST', headers: { [APP_MANAGEMENT_SIGNATURE_HEADER]: forStatus }, body: JSON.stringify(version) })
    expect(replayed.status).toBe(401)
    expect((await ask(target, 'GET', APP_MANAGEMENT_PATHS.status)).body.activeVersion).toBeNull()
    // A platform's health check needs no key. It says only when the app must run next: with no app yet, never.
    expect(await (await fetch(`${target.origin}${APP_MANAGEMENT_PATHS.health}`)).json()).toEqual({ ok: true, nextWakeAt: null })
  })

  test('an app with a link is private: only a browser that came in with the link gets its page and its calls', async () => {
    // WHY (§7, decision 8): a deployment has an address that other people can
    // reach. Until its owner makes it public, the link is the only way in, and
    // a new link puts each earlier visitor out.
    const target = await deployment()
    await push(target, await built(NOTES, 1))
    const stranger = visitor(target)
    expect((await stranger.page()).status).toBe(401)
    expect((await stranger.call('list')).status).toBe(401)
    expect(await stranger.enter('W'.repeat(43))).toBe(401)

    const browser = await guest(target)
    const page = await browser.page()
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('<title>Notes</title>')
    // The page gets `window.solusApp` from the deployment, as it gets it from Solus in the app frame.
    expect(html).toContain('window.solusApp')
    expect((await browser.call('list')).body).toEqual({ ok: true, value: [] })
    // The page of another site cannot make the visitor's browser call the app: it cannot send the header.
    const forged = await fetch(`${target.origin}${APP_VISITOR_PATHS.call}`, { method: 'POST', body: JSON.stringify({ name: appOperationCallName('list'), argumentsJson: '{}' }) })
    expect(forged.status).toBe(404)

    await push(target, await built(NOTES, 1, { ...LINK, linkSecret: 'N'.repeat(43) }))
    expect((await browser.call('list')).status).toBe(401)
  })

  test('a public app answers each person, and a viewer reads and does not change', async () => {
    // WHY (§7, decision 9): public is the owner's choice, and the role says
    // what a person with no account may do. A query never writes (apps.md §5).
    const target = await deployment()
    await push(target, await built(NOTES, 1, { mode: 'public', role: 'viewer', linkSecret: LINK_SECRET }))
    const anyone = visitor(target)
    expect((await anyone.page()).status).toBe(200)
    expect((await anyone.call('list')).body).toEqual({ ok: true, value: [] })
    expect((await anyone.call('add', { text: 'no' })).body).toEqual({ ok: false, error: 'You can read in this app, and you cannot change it.' })
    // The app's code reads the role of its caller; a visitor has no user.
    expect((await anyone.call('whoAndWhat')).body.value.caller).toEqual({ kind: 'ui', role: 'viewer' })

    await push(target, await built(NOTES, 1, { mode: 'public', role: 'editor', linkSecret: LINK_SECRET }))
    expect((await anyone.call('add', { text: 'yes' })).body).toEqual({ ok: true, value: { id: 1, text: 'yes' } })
  })

  test('a version that does not start leaves the version before it running', async () => {
    // WHY: a bad publish must not take a public app down.
    const target = await deployment()
    await push(target, await built(NOTES, 1))
    const browser = await guest(target)
    await browser.call('add', { text: 'kept' })
    const broken = (await push(target, await built({ ...NOTES, migrations: { '0001_notes.sql': 'CREATE TABLE other (id INTEGER PRIMARY KEY);' } }, 2))).body
    expect(broken).toMatchObject({ version: 2, active: false })
    expect(broken.error).toContain('Version 2 did not start')
    expect((await browser.call('list')).body.value).toEqual([{ id: 1, text: 'kept' }])

    const next: AppProjectFiles = {
      ...NOTES,
      app: NOTES.app.replace("'SELECT id, text FROM notes ORDER BY id'", "'SELECT id, text, done FROM notes ORDER BY id'"),
      migrations: { ...NOTES.migrations, '0002_done.sql': 'ALTER TABLE notes ADD COLUMN done INTEGER NOT NULL DEFAULT 0;' },
    }
    expect((await push(target, await built(next, 3))).body).toEqual({ version: 3, active: true, error: null })
    expect((await browser.call('list')).body.value).toEqual([{ id: 1, text: 'kept', done: 0 }])
  })

  test('the app\'s own secrets come from the env vars of the deployment, and a deployment keeps its app, its data, and its access when it starts again', async () => {
    // WHY (decision 14): a secret is not in the data that a platform saves.
    // WHY (decision 4): the data is beside the container, so a new container
    // on the same data is the same app, with the same link.
    const first = await deployment({ SOLUS_APP_SECRET_TOKEN: 'from-env' })
    await push(first, await built(NOTES, 1))
    const browser = await guest(first)
    expect((await browser.call('whoAndWhat')).body.value.token).toBe('from-env')
    await browser.call('add', { text: 'before the restart' })

    const second = await first.restart()
    const again = await guest(second)
    expect((await again.call('list')).body.value).toEqual([{ id: 1, text: 'before the restart' }])
    expect((await again.call('whoAndWhat')).body.value.token).toBe('from-env')
  })

  test('a deployment holds one app and refuses the version of another', async () => {
    const target = await deployment()
    await push(target, await built(NOTES, 1))
    const other = await push(target, { ...(await built(NOTES, 1)), app: { id: 'another-app', slug: 'other' } })
    expect(other).toEqual({ status: 409, body: { error: 'This deployment holds the app notes. It does not take another app.' } })
    expect((await ask(target, 'GET', APP_MANAGEMENT_PATHS.status)).body).toMatchObject({ activeVersion: 1 })
  })

  test('an app for named people sends a visitor to Solus to sign in, and its code reads who the person is', async () => {
    // WHY (§7.3): the owner shares the app with people of Solus, and not with
    // each holder of a link. The deployment learns who a visitor is only from
    // Solus Cloud, and its code reads that in `ctx.caller`.
    const cloud = solusCloud()
    const target = await deployment({}, signature.newAppKey(), cloud.fetch)
    await push(target, await built(NOTES, 1, { mode: 'people', role: 'editor', linkSecret: LINK_SECRET, signIn: { origin: 'https://app.example.test', app: 'copy-1' } }))
    const browser = visitor(target)
    const closed = await browser.page()
    expect(closed.status).toBe(401)
    expect(await closed.text()).toContain('Sign in with Solus')
    // The link of before opens nothing now.
    expect(await browser.enter(LINK_SECRET)).toBe(401)

    const out = await browser.go(APP_VISITOR_PATHS.signIn)
    expect(out.status).toBe(302)
    const enter = new URL(out.headers.get('location') ?? '')
    expect(`${enter.origin}${enter.pathname}`).toBe('https://app.example.test/apps/enter')
    expect(enter.searchParams.get('app')).toBe('copy-1')
    browser.keep(out)

    cloud.answer = { user: { id: 'bob', name: 'Bob' }, role: 'viewer' }
    const back = await browser.go(`${APP_VISITOR_PATHS.callback}?code=${'c'.repeat(43)}&state=${enter.searchParams.get('state')}`)
    expect(back.status).toBe(302)
    expect(back.headers.get('location')).toBe('/')
    browser.keep(back)
    // The deployment proved to Solus Cloud that it started this sign-in: it sent the verifier of the challenge.
    expect(cloud.requests).toHaveLength(1)
    expect(cloud.requests[0]).toMatchObject({ app: 'copy-1', code: 'c'.repeat(43) })
    expect(createHash('sha256').update(cloud.requests[0]?.verifier ?? '').digest('base64url')).toBe(enter.searchParams.get('challenge') ?? '')

    expect((await browser.page()).status).toBe(200)
    expect((await browser.call('whoAndWhat')).body.value.caller).toEqual({ kind: 'ui', role: 'viewer', user: { id: 'bob', name: 'Bob' } })
    expect((await browser.call('add', { text: 'no' })).body).toEqual({ ok: false, error: 'You can read in this app, and you cannot change it.' })
  })

  test('a sign-in that Solus refuses, or that another browser started, opens nothing', async () => {
    // WHY: a code passes through a browser. A code with no start in this
    // browser is not this visitor's, and a person whom the owner did not name
    // gets no session.
    const cloud = solusCloud()
    const target = await deployment({}, signature.newAppKey(), cloud.fetch)
    await push(target, await built(NOTES, 1, { mode: 'people', role: 'editor', linkSecret: LINK_SECRET, signIn: { origin: 'https://app.example.test', app: 'copy-1' } }))

    const other = visitor(target)
    const forged = await other.go(`${APP_VISITOR_PATHS.callback}?code=${'c'.repeat(43)}&state=${'s'.repeat(22)}`)
    expect(forged.status).toBe(403)
    expect(cloud.requests).toEqual([])

    const browser = visitor(target)
    const out = await browser.go(APP_VISITOR_PATHS.signIn)
    browser.keep(out)
    cloud.answer = null
    const back = await browser.go(`${APP_VISITOR_PATHS.callback}?code=${'c'.repeat(43)}&state=${new URL(out.headers.get('location') ?? '').searchParams.get('state')}`)
    expect(back.status).toBe(403)
    expect(await back.text()).toContain('This app is not shared with you')
    browser.keep(back)
    expect((await browser.page()).status).toBe(401)
  })

  test('another service sends a webhook to the deployment, which checks it as Solus does and runs the mutation', async () => {
    // WHY (§7.4): the copy is at its own address while its Solus can be off.
    // The check is the one the app declares, with the secret of its env vars.
    const target = await deployment({ SOLUS_APP_WEBHOOK_SECRET_PUSHED: Buffer.from('hook-secret').toString('base64') })
    await push(target, await built(HOOKED, 1))
    const send = (name: string, token: string) => fetch(`${target.origin}${APP_WEBHOOK_PATH_PREFIX}${name}?source=ci`, { method: 'POST', headers: { 'x-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'from a hook' }) })

    expect((await send('pushed', 'not-the-secret')).status).toBe(401)
    expect((await send('unknown', 'hook-secret')).status).toBe(404)
    const taken = await send('pushed', 'hook-secret')
    expect([taken.status, await taken.json()]).toEqual([200, { ok: true }])
    const browser = await guest(target)
    // Only the request that passed the check ran the mutation, with the request as its input.
    expect((await browser.call('list')).body.value).toEqual([{ id: 1, text: 'from a hook (ci)' }])
  })

  test('a platform reads when the app must run next, and Solus runs one operation for a model call', async () => {
    // WHY (§8.3): a platform that stops an idle container must start it for the next schedule.
    // WHY (§5.2): a model call runs in Solus, and each operation it uses as a tool runs here, on the data of the copy.
    const target = await deployment()
    await push(target, await built(NOTES, 1))
    const health = await (await fetch(`${target.origin}${APP_MANAGEMENT_PATHS.health}`)).json()
    // NOTES has a schedule for each five minutes.
    expect(health.nextWakeAt).toBeGreaterThan(Date.now())
    expect(health.nextWakeAt).toBeLessThanOrEqual(Date.now() + 5 * 60_000)

    const call = { operation: 'add', input: { text: 'by a model' }, caller: { kind: 'model', callId: 'call-1' } }
    expect((await ask(target, 'POST', APP_MANAGEMENT_PATHS.operations, call)).body).toEqual({ ok: true, value: { id: 1, text: 'by a model' } })
    // The app's own failure is an answer for the model, not a failure of the request.
    expect((await ask(target, 'POST', APP_MANAGEMENT_PATHS.operations, { ...call, input: {} })).body).toMatchObject({ ok: false })
    expect((await ask(target, 'POST', APP_MANAGEMENT_PATHS.operations, call, signature.newAppKey())).status).toBe(401)
  })
})

/** NOTES with a mutation that takes a webhook's request as its input. */
const HOOKED: AppProjectFiles = {
  ...NOTES,
  app: NOTES.app
    .replace("run: 'add' } },\n})", "run: 'received' } },\n})")
    .replace('  operations: {', `  operations: {
    received: mutation({ input: z.object({ headers: z.record(z.string(), z.string()), query: z.record(z.string(), z.string()), body: z.object({ text: z.string() }) }) }, (ctx, input) =>
      ctx.sql.exec('INSERT INTO notes (text) VALUES (?) RETURNING id, text', input.body.text + ' (' + input.query.source + ')').one()),`),
}

/** Solus Cloud for a sign-in: it records each exchange and answers with `answer`, or refuses with none. */
function solusCloud() {
  const state: { requests: { app: string; code: string; verifier: string }[]; answer: AppSignInEntry | null; fetch: typeof fetch } = {
    requests: [],
    answer: null,
    // SAFETY: the runtime calls `fetch` with a URL and an init; this answers that form.
    fetch: (async (_input: URL, init?: RequestInit) => {
      state.requests.push(appSignInEntryRequestSchema.parse(JSON.parse(String(init?.body))))
      return state.answer ? Response.json(state.answer) : Response.json({ error: 'invalid_app_entry' }, { status: 403 })
    }) as typeof fetch,
  }
  return state
}
