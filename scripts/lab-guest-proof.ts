/**
 * The guest-link proof (docs/plans/multiplayer-sharing.md §4.2): a share link opened
 * in a browser lands a visitor with no account on the one shared resource, through a
 * real host's ticket door, and loses it the moment the link is regenerated.
 *
 * The Lab issuer stands in for Solus cloud. A small origin serves the built web client
 * under `/app/` and mints guest grants at `/v1/hosts/:id/guest-grant`, exactly as the
 * account origin does; the host trusts the issuer's key and admits the grant only with
 * the link secret. Nothing here touches `~/.solus`.
 *
 *   bun run build:test && bun scripts/lab-guest-proof.ts
 *
 * Screenshots land in `.solus-local/artifacts/guest-*.png`.
 */
import { spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { z } from 'zod'
import { bootLabHost, type LabHost } from '@solus/lab/host'
import { LabClient } from '@solus/lab/client'
import { LabIssuer } from '@solus/lab/issuer'
import { personaForHost } from '@solus/lab/personas'
import { guestLinkFragment } from '@solus/contracts/sharing'

const ROOT = resolve(import.meta.dirname, '..')
const APP_DIR = resolve(ROOT, '.solus-local/guest-proof/app')
const ARTIFACTS = resolve(ROOT, '.solus-local/artifacts')
let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript'], ['.css', 'text/css'], ['.svg', 'image/svg+xml'],
  ['.json', 'application/json'], ['.png', 'image/png'], ['.woff2', 'font/woff2'], ['.webmanifest', 'application/manifest+json'],
])
const addressSchema = z.object({ port: z.number().int().positive() })
const guestRequestSchema = z.object({ guestId: z.string().regex(/^[a-zA-Z0-9_-]{16,64}$/).optional(), displayName: z.string().max(160).optional() })

/** The account origin in miniature: the bundle at `/app/`, guest grants at `/v1`. */
function startOrigin(issuer: LabIssuer, host: LabHost): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const guestGrant = /^\/v1\/hosts\/([^/]+)\/guest-grant$/.exec(url.pathname)
    if (request.method === 'POST' && guestGrant) {
      let body = ''
      request.on('data', (chunk: Buffer) => { body += chunk.toString() })
      request.on('end', () => {
        const parsed = guestRequestSchema.safeParse(body ? JSON.parse(body) : {})
        if (!parsed.success || guestGrant[1] !== host.hostId) {
          response.statusCode = parsed.success ? 404 : 400
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ error: parsed.success ? 'host_not_found' : 'invalid_request' }))
          return
        }
        const guestId = parsed.data.guestId ?? 'web-guest-0123456789abcd'
        const displayName = parsed.data.displayName?.trim() || 'Guest'
        const grant = issuer.mint({ id: 'web-guest', kind: 'guest', guestId, displayName }, { hostId: host.hostId, hostKind: 'personal', hostOwnerUserId: 'user-alice' })
        response.setHeader('content-type', 'application/json')
        response.setHeader('cache-control', 'no-store')
        response.end(JSON.stringify({ grant, hostId: host.hostId, expiresAt: Date.now() + 600_000, guestId, displayName, routes: [{ kind: 'tunnel', url: host.tunnelUrl }] }))
      })
      return
    }
    if (url.pathname.startsWith('/v1/')) {
      response.statusCode = 401
      response.setHeader('content-type', 'application/json')
      response.end('{"error":"unauthorized"}')
      return
    }
    // The bundle under /app/, with the SPA fallback the account origin has.
    const relative = normalize(url.pathname.replace(/^\/app\/?/, '')).replace(/^(\.\.[/\\])+/, '')
    let file = join(APP_DIR, relative)
    if (!url.pathname.startsWith('/app') || !existsSync(file) || statSync(file).isDirectory()) file = join(APP_DIR, 'index.html')
    response.setHeader('content-type', MIME.get(extname(file)) ?? 'application/octet-stream')
    response.setHeader('cache-control', 'no-cache')
    response.end(readFileSync(file))
  })
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = addressSchema.safeParse(server.address())
      resolvePromise({ server, origin: `http://127.0.0.1:${address.success ? address.data.port : 0}` })
    })
  })
}

async function landAsGuest(page: Page, origin: string, hostId: string, secret: string, name: string): Promise<string[]> {
  const refused: string[] = []
  page.on('console', (message) => {
    const text = message.text()
    if (/FORBIDDEN|not available to a guest|not shared with you/.test(text)) refused.push(text)
  })
  await page.goto(`${origin}/app/${guestLinkFragment(hostId, secret)}`)
  await page.getByTestId('guest-name').waitFor({ timeout: 15_000 })
  await page.getByTestId('guest-name').fill(name)
  await page.getByTestId('guest-continue').click()
  await page.getByTestId('guest-shell').waitFor({ timeout: 20_000 })
  return refused
}

/** The owner's side: the header verb, and a dialog whose footer copies the current link. */
async function proveOwnerShareDialog(browser: Browser, localUrl: string, workId: string, secret: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await context.addInitScript((url: string) => {
    localStorage.setItem('solus.servers', JSON.stringify([{ id: 'local', label: 'Lab', url, sessionToken: '', lastConnected: Date.now() }]))
    localStorage.setItem('solus.activeServerId', 'local')
    localStorage.setItem('solus-settings', JSON.stringify({ onboardingCompleted: true }))
  }, localUrl)
  const page = await context.newPage()
  await page.goto(localUrl)
  await page.locator('[data-testid="message-input"]').first().waitFor({ timeout: 20_000 })
  await page.evaluate((route: string) => window.dispatchEvent(new CustomEvent('solus:open-route', { detail: route })), `/work/${workId}`)
  const shareButton = page.getByTestId('share-button').first()
  check('the work header always carries a Share verb', await shareButton.waitFor({ timeout: 20_000 }).then(() => true).catch(() => false))
  check('the verb is one word, like its neighbours', (await shareButton.textContent())?.trim() === 'Share')
  check('the state rides the tooltip, not the header', (await shareButton.getAttribute('title'))?.includes('anyone with the link') === true)
  await shareButton.click()
  await page.getByTestId('share-dialog').waitFor({ timeout: 10_000 })
  // The link needs the host's answer on its cloud link first; the button enables then.
  const copy = page.locator('[data-testid="share-copy-link"]:enabled')
  const ready = await copy.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false)
  check('Copy link is one click away in the footer on every open, with the current link', ready && (await copy.getAttribute('data-link'))?.includes(secret) === true)
  check('the URL itself is not spelled out in the dialog', (await page.getByTestId('share-dialog').textContent())?.includes(secret) === false)
  // Let the dialog's entrance settle before the picture.
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(ARTIFACTS, 'share-dialog-owner.png') })
  await context.close()
}

/** An editor on a session: the workspace's conversation column, composer live and floating over the transcript. */
async function proveEditorComposer(page: Page): Promise<void> {
  const composer = page.getByTestId('guest-composer')
  await composer.locator('[data-testid="message-input"]').waitFor({ timeout: 20_000 }).catch(() => null)
  // The bar folds its toolbar row (itself inert) while the keyboard is elsewhere,
  // as the workspace dock does; the read-only rule is on the toolbar's own root.
  check('an editor gets the conversation page\'s composer, live', (await composer.locator('[data-testid="message-input"] .cm-content[contenteditable="true"]').count()) === 1 && (await composer.locator('[data-testid="input-toolbar"][inert]').count()) === 0)
  check('the composer floats over the transcript and the column holds its band', await page.evaluate(() => {
    const dock = document.querySelector('[data-testid="guest-composer"]')
    const column = dock?.parentElement
    return !!dock && getComputedStyle(dock).position === 'absolute' && parseFloat(column?.style.getPropertyValue('--solus-composer-inset') ?? '0') > 0
  }))
  check('an editor link on a session says whose account the turn runs on', await page.getByTestId('guest-session-note').isVisible().catch(() => false))
}

/** An editor guest sends a prompt from the browser composer and the host runs the turn. */
async function proveGuestPrompt(page: Page): Promise<void> {
  const main = page.getByTestId('guest-main')
  const composer = page.getByTestId('guest-composer')
  // Alice's turn settles first: the corner button is a Send again, not a Stop.
  await composer.locator('[data-testid="send-button"]').waitFor({ timeout: 20_000 }).catch(() => null)
  const answers = main.getByText('mock response from the test agent')
  const answersBefore = await answers.count()
  await composer.locator('[data-testid="message-input"] .cm-content').click()
  await page.keyboard.type('hello from Maya, sent from the guest composer')
  await page.keyboard.press('Enter')
  const echoed = await main.getByText('hello from Maya, sent from the guest composer').first().waitFor({ timeout: 20_000 }).then(() => true).catch(() => false)
  check('a prompt typed in the guest composer lands in the transcript', echoed)
  const deadline = Date.now() + 20_000
  while ((await answers.count()) <= answersBefore && Date.now() < deadline) await page.waitForTimeout(200)
  const answersAfter = await answers.count()
  check('the host runs the guest\'s turn and the answer streams back', answersAfter > answersBefore, `${answersBefore} → ${answersAfter} answers; transcript: ${JSON.stringify((await main.textContent())?.slice(0, 400))}`)
  check('the composer is empty again, ready for the next prompt', (await composer.locator('.cm-content').textContent())?.includes('hello from Maya') === false)
  await page.screenshot({ path: join(ARTIFACTS, 'guest-session-prompted.png') })
}

/** A viewer on a session: the conversation page as a member sees it, with a composer that takes no input. */
async function proveViewerSession(context: BrowserContext, origin: string, hostId: string, secret: string): Promise<void> {
  const page = await context.newPage()
  await landAsGuest(page, origin, hostId, secret, 'Maya')
  check('the guest is a viewer on the session', (await page.getByTestId('guest-role').textContent())?.trim() === 'Viewer')
  const composer = page.getByTestId('guest-composer')
  const readOnly = composer.locator('[data-testid="message-input"] .cm-content[contenteditable="false"]')
  await readOnly.waitFor({ timeout: 20_000 }).catch(() => null)
  await page.screenshot({ path: join(ARTIFACTS, 'guest-session-viewer.png') })
  check('a viewer gets the same composer, taking no input', (await readOnly.count()) === 1, `page: ${JSON.stringify((await page.getByTestId('guest-main').textContent())?.slice(0, 300))}`)
  check('the composer says why in place of a prompt', (await composer.locator('.cm-placeholder').textContent({ timeout: 5_000 }).catch(() => ''))?.includes('You can view this session') === true)
  check('the toolbar is inert and send is off', (await composer.locator('[data-testid="input-toolbar"][inert]').count()) === 1 && (await composer.locator('[data-testid="send-button"]:disabled').count()) === 1)
  check('a viewer is not told whose account a turn would run on', (await page.getByTestId('guest-session-note').count()) === 0)
  await page.close()
}

/**
 * A task shared by link: the rail names the task and its sessions, a session
 * opens in the same shell with the task as the crumb before it, and that crumb
 * is the way back to the page.
 */
async function proveTaskLink(context: BrowserContext, origin: string, host: LabHost, alice: LabClient, sessionId: string): Promise<void> {
  const task = await alice.rpc('tasksCreate', { title: 'Guest proof task', projectKey: host.dataDir })
  await alice.rpc('tasksLinkSession', task.id, sessionId, 'working')
  const taskLink = (await alice.rpc('shareSetLink', { resource: { kind: 'task', id: task.id }, role: 'editor' }))!
  const page = await context.newPage()
  await landAsGuest(page, origin, host.hostId, taskLink.secret, 'Maya')
  await page.getByTestId('guest-task').waitFor({ timeout: 20_000 }).catch(() => null)
  check('the task page opens for a task link', (await page.getByTestId('guest-task').count()) === 1)
  const railSession = page.getByTestId('guest-rail-session').first()
  check('the rail lists the task\'s session', await railSession.waitFor({ timeout: 20_000 }).then(() => true).catch(() => false))
  check('the rail says what the guest may do', (await page.getByTestId('guest-rail-access').textContent())?.includes('edit this task') === true)
  await page.screenshot({ path: join(ARTIFACTS, 'guest-task.png') })
  await railSession.click()
  const crumb = page.getByTestId('guest-back-to-task')
  check('the session opens in the shell with the task as the crumb before it', await crumb.waitFor({ timeout: 20_000 }).then(() => true).catch(() => false) && (await crumb.textContent())?.includes('Guest proof task') === true)
  await page.locator('[data-testid="guest-composer"] [data-testid="message-input"]').waitFor({ timeout: 20_000 }).catch(() => null)
  check('the composer is live under a task editor link', (await page.locator('[data-testid="guest-composer"] [data-testid="message-input"] .cm-content[contenteditable="true"]').count()) === 1)
  await page.screenshot({ path: join(ARTIFACTS, 'guest-task-session.png') })
  await crumb.click()
  check('the crumb returns to the task page', await page.getByTestId('guest-task').waitFor({ timeout: 20_000 }).then(() => true).catch(() => false))
  await page.getByTestId('guest-rail-toggle').click()
  check('the rail can be hidden', (await page.getByTestId('guest-rail').count()) === 0)
  await page.close()
  await alice.rpc('shareSetLink', { resource: { kind: 'task', id: task.id }, role: null })
}

async function main(): Promise<number> {
  mkdirSync(ARTIFACTS, { recursive: true })
  console.log('== building the web client under /app/')
  const build = spawnSync('bun', ['run', 'build', '--base=/app/', '--outDir', APP_DIR, '--emptyOutDir'], { cwd: resolve(ROOT, 'apps/client'), stdio: 'pipe' })
  if (build.status !== 0) {
    console.error(build.stderr.toString())
    throw new Error('the web client build failed')
  }

  const issuer = new LabIssuer()
  await issuer.start()
  // `SOLUS_LAB_ENTRY` names a private copy of the test bundle: a running dev app
  // rewrites `dist/main` on every server change, and the Lab would spawn that.
  const host = await bootLabHost({ flavor: 'personal', issuer, entry: process.env.SOLUS_LAB_ENTRY })
  console.log(`== host ${host.hostId} · data ${host.dataDir} · tunnel ${host.tunnelUrl}`)
  const { server: originServer, origin } = await startOrigin(issuer, host)
  console.log(`== origin ${origin}`)
  const alice = new LabClient({ persona: personaForHost('alice', 'personal'), hostUrl: host.localUrl, issuer, hostId: host.hostId, hostKind: 'personal', credentialFree: true })
  const browser = await chromium.launch()
  try {
    const dialed = await alice.connect()
    if (!dialed.ok) throw new Error(`alice could not connect: ${JSON.stringify(dialed)}`)

    console.log('== alice shares a document by a viewer link and a session by an editor link')
    const work = await alice.rpc('createWork', 'Guest proof', 'doc', '# Hello guest\n\nA document shared by link.', '# Hello guest\n\nA document shared by link.', undefined, 'claude-code', host.dataDir)
    const workLink = await alice.rpc('shareSetLink', { resource: { kind: 'work', id: work.id }, role: 'viewer' })
    // A named model, so a later prompt on a settled session can rebuild its run input.
    const created = await alice.rpc('createHeadlessSession', { prompt: 'hello from alice', provider: 'claude-code', modelId: 'mock-model', reasoningEffort: 'medium', contextWindow: null, cwd: host.dataDir, skipTaskCreation: true })
    const sessionLink = await alice.rpc('shareSetLink', { resource: { kind: 'session', id: created.agentSessionId }, role: 'editor' })
    check('both links minted a secret', !!workLink?.secret && !!sessionLink?.secret)
    if (!workLink || !sessionLink) return 1

    console.log('== the owner: a Share verb on the header, and the link at hand on every open')
    await proveOwnerShareDialog(browser, host.localUrl, work.id, workLink.secret)

    console.log('== the document link, on a laptop')
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    const refusedOnWork = await landAsGuest(page, origin, host.hostId, workLink.secret, 'Maya')
    check('the guest shell shows the document title', (await page.getByTestId('guest-title').textContent())?.includes('Guest proof') === true)
    check('the guest is a viewer', (await page.getByTestId('guest-role').textContent())?.trim() === 'Viewer')
    check('the guest is named', (await page.getByTestId('guest-name-label').textContent())?.includes('Maya') === true)
    const main = page.getByTestId('guest-main')
    await main.getByText('Hello guest').first().waitFor({ timeout: 20_000 }).catch(() => null)
    check('the document body renders', await main.getByText('Hello guest').first().isVisible().catch(() => false))
    check('the editor says read-only for a viewer', await main.getByText('Read-only').first().isVisible().catch(() => false))
    check('nothing host-wide is offered: no sidebar, no project panel, no composer', (await page.locator('[data-testid="message-input"], .sidebar-header-desktop, .side-panel-root').count()) === 0)
    check('the work header offers no way into the workspace: no crumb, no Ask Solus, no publish, no share, no close', (await page.locator('[data-testid="open-chat"], [data-testid="document-modal-close"], [data-testid="share-button"], [data-testid="work-publish-menu"]').count()) === 0 && (await main.getByRole('link', { name: 'Workspace' }).count()) === 0 && (await main.getByText('Publish', { exact: true }).count()) === 0)
    await page.screenshot({ path: join(ARTIFACTS, 'guest-document.png'), fullPage: false })
    check('the address bar keeps the link for a reload', page.url().includes(`/s/${workLink.secret}`))
    check('the host registry is untouched by the visit', await page.evaluate(() => localStorage.getItem('solus.servers')) === null)
    check('the guest identity is kept in the browser', await page.evaluate(() => JSON.parse(localStorage.getItem('solus.guest') ?? 'null')?.displayName) === 'Maya')

    console.log('== the same document on a phone')
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const phonePage = await phone.newPage()
    await landAsGuest(phonePage, origin, host.hostId, workLink.secret, 'Maya')
    const phoneMain = phonePage.getByTestId('guest-main')
    await phoneMain.getByText('Hello guest').first().waitFor({ timeout: 20_000 }).catch(() => null)
    check('the document renders on a phone', await phoneMain.getByText('Hello guest').first().isVisible().catch(() => false))
    await phonePage.screenshot({ path: join(ARTIFACTS, 'guest-document-phone.png') })
    await phone.close()

    console.log('== the session link')
    const sessionContext = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const sessionPage = await sessionContext.newPage()
    const refusedOnSession = await landAsGuest(sessionPage, origin, host.hostId, sessionLink.secret, 'Maya')
    check('the guest is an editor on the session', (await sessionPage.getByTestId('guest-role').textContent())?.trim() === 'Editor')
    await proveEditorComposer(sessionPage)
    // The mock backend keeps no transcript on disk, so history is empty here; what a
    // guest must see is the live turn: alice prompts, the guest's transcript moves.
    await alice.rpc('promptSession', created.agentSessionId, 'second prompt from alice, while Maya watches')
    const sessionMain = sessionPage.getByTestId('guest-main')
    const streamed = await sessionMain.getByText('second prompt from alice').first().waitFor({ timeout: 20_000 }).then(() => true).catch(() => false)
    check('the guest sees the turn alice starts, live', streamed)
    check('the transcript does not call a live host unreachable', (await sessionPage.locator('[data-testid="host-status-row"]').count()) === 0)
    await sessionPage.screenshot({ path: join(ARTIFACTS, 'guest-session.png') })

    console.log('== Maya sends a prompt from the guest composer')
    await proveGuestPrompt(sessionPage)

    // The same session, its link turned to viewer: the mock backend reports one
    // provider id for every run, so a second mock session cannot keep its own
    // identity once turns have run; one session, two roles, proves the same thing.
    console.log('== the session link turned to viewer')
    await alice.rpc('shareSetLink', { resource: { kind: 'session', id: created.agentSessionId }, role: 'viewer' })
    await proveViewerSession(sessionContext, origin, host.hostId, sessionLink.secret)

    console.log('== a task shared by link, with the session under it')
    await proveTaskLink(sessionContext, origin, host, alice, created.agentSessionId)

    console.log('== alice regenerates the session link')
    await alice.rpc('shareSetLink', { resource: { kind: 'session', id: created.agentSessionId }, role: 'editor', regenerate: true })
    const revokedAt = Date.now()
    const revoked = await sessionPage.getByTestId('guest-revoked').waitFor({ timeout: 30_000 }).then(() => true).catch(() => false)
    check('the guest is told the link no longer works', revoked, `${Date.now() - revokedAt} ms`)
    await sessionPage.screenshot({ path: join(ARTIFACTS, 'guest-revoked.png') })
    check('the document guest is unaffected', await page.getByTestId('guest-revoked').count() === 0)

    console.log('== a stale link on a fresh visit')
    const stalePage = await sessionContext.newPage()
    await stalePage.goto(`${origin}/app/${guestLinkFragment(host.hostId, sessionLink.secret)}`)
    await stalePage.getByTestId('guest-name').waitFor({ timeout: 15_000 })
    await stalePage.getByTestId('guest-continue').click()
    const staleOutcome = await Promise.race([
      stalePage.getByText('This link no longer works').first().waitFor({ timeout: 30_000 }).then(() => 'revoked' as const),
      stalePage.getByTestId('guest-shell').waitFor({ timeout: 30_000 }).then(() => 'admitted' as const),
    ]).catch(() => 'timeout' as const)
    check('a stale link never opens the shell', staleOutcome === 'revoked', staleOutcome)

    const hostLog = existsSync(join(host.dataDir, 'dev.log')) ? readFileSync(join(host.dataDir, 'dev.log'), 'utf8') : ''
    const refusedMethods = [...hostLog.matchAll(/"msg":"rpc_access_refused".*?"method":"([^"]+)"/g)].map((match) => match[1])
    console.log(`== host-wide calls the guest shell made and the host refused: ${refusedMethods.length === 0 ? 'none' : [...new Set(refusedMethods)].join(', ')}`)
    console.log(`== refusals seen in the browser console: ${[...refusedOnWork, ...refusedOnSession].length}`)
    await context.close()
    await sessionContext.close()
  } finally {
    alice.close()
    await browser.close()
    originServer.close()
    await host.stop()
    await issuer.stop()
  }
  console.log(`\n== ${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failed check(s)`)
  return failures === 0 ? 0 : 1
}

process.exit(await main())
