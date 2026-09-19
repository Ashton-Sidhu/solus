/**
 * The cloud page proof (docs/plans/cloud-service-model.md, P1 exit test): every runner
 * off, the task board and a document are usable on a phone; a runner comes up and an
 * agent's task appears live.
 *
 * The Lab issuer stands in for Solus cloud. A small account origin serves the built
 * web client under `/app/`, answers `GET /v1/hosts` with the organization's workspace
 * row for a signed-in cookie, and mints a workspace grant at
 * `POST /v1/hosts/workspace:<orgId>/grant`; the page shell dials the Lab's workspace
 * service with it. Nothing here touches `~/.solus`.
 *
 *   bun run build:test && bun scripts/lab-cloud-page-proof.ts
 *
 * Screenshots land in `.solus-local/artifacts/cloud-page-*.png`. `KEEP=1` keeps the
 * temporary data directories for diagnosis; `SKIP_APP_BUILD=1` reuses the last
 * `/app/` build.
 */
import { spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, normalize, resolve } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { z } from 'zod'
import { WORKSPACE_AUDIENCE, workspaceHostId, type DirectoryHost } from '@solus/contracts/uplink'
import { bootLabHost, type LabHost } from '@solus/lab/host'
import { LabClient, LabRpcError } from '@solus/lab/client'
import { LabIssuer } from '@solus/lab/issuer'
import { ORGANIZATION_ID, PERSONAS, personaForHost } from '@solus/lab/personas'
import { bootWorkspaceService, type WorkspaceService } from '@solus/lab/workspace'

const ROOT = resolve(import.meta.dirname, '..')
const APP_DIR = resolve(ROOT, '.solus-local/cloud-proof/app')
const ARTIFACTS = resolve(ROOT, '.solus-local/artifacts')
const ORGANIZATION_NAME = 'Lab organization'
const RUNNER_HOST_ID = 'labrunnerabcdefg'
const RUNNER_TASK_TITLE = 'Runner task from the mock agent'
const ALICE_COOKIE = 'solus_session=alice'
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

/**
 * The account origin in miniature: the bundle at `/app/`, the directory and a
 * workspace grant at `/v1` for alice's cookie, 401 for everyone else.
 */
function startOrigin(issuer: LabIssuer, service: WorkspaceService): Promise<{ server: Server; origin: string }> {
  const workspaceRow: DirectoryHost = {
    hostId: workspaceHostId(ORGANIZATION_ID),
    installationId: workspaceHostId(ORGANIZATION_ID),
    label: ORGANIZATION_NAME,
    kind: 'cloud',
    organizationId: ORGANIZATION_ID,
    routes: [{ kind: 'tunnel', url: service.url }],
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname.startsWith('/v1/')) {
      const signedIn = (request.headers.cookie ?? '').split(';').some((part) => part.trim() === ALICE_COOKIE)
      response.setHeader('content-type', 'application/json')
      response.setHeader('cache-control', 'no-store')
      if (!signedIn) {
        response.statusCode = 401
        response.end('{"error":"unauthorized"}')
        return
      }
      if (request.method === 'GET' && url.pathname === '/v1/hosts') {
        response.end(JSON.stringify({ hosts: [workspaceRow] }))
        return
      }
      if (request.method === 'POST' && url.pathname === `/v1/hosts/${encodeURIComponent(workspaceRow.hostId)}/grant`) {
        response.end(JSON.stringify({ grant: issuer.issueWorkspaceGrant(PERSONAS.alice), hostId: workspaceRow.hostId, expiresAt: Date.now() + 600_000 }))
        return
      }
      response.statusCode = 404
      response.end('{"error":"host_not_found"}')
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

function workspaceClient(personaId: 'alice' | 'bob', issuer: LabIssuer, service: WorkspaceService): LabClient {
  return new LabClient({ persona: personaForHost(personaId, 'managed'), hostUrl: service.url, issuer, hostId: WORKSPACE_AUDIENCE, hostKind: 'cloud' })
}

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = await read()
  while (!accept(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
    last = await read()
  }
  return last
}

/** The runner's own log says when it holds a grant for the organization. */
async function runnerLinked(runner: LabHost, timeoutMs: number): Promise<boolean> {
  const logFile = join(runner.dataDir, 'dev.log')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(logFile) && readFileSync(logFile, 'utf8').includes('"msg":"runner_grant_minted"')) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

async function signedInContext(browser: Browser, origin: string, phone: boolean): Promise<BrowserContext> {
  const context = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    : { viewport: { width: 1280, height: 800 } })
  await context.addCookies([{ name: 'solus_session', value: 'alice', url: origin }])
  return context
}

async function openPage(context: BrowserContext, origin: string, fragment: string): Promise<Page> {
  const page = await context.newPage()
  page.on('pageerror', (error) => console.log(`   [page error] ${error.message}`))
  await page.goto(`${origin}/app/${fragment}`)
  await page.getByTestId('page-shell').waitFor({ timeout: 20_000 })
  return page
}

const isVisible = (page: Page, selector: string, timeout = 20_000): Promise<boolean> =>
  page.locator(selector).first().waitFor({ timeout }).then(() => true).catch(() => false)

/**
 * No conversation composer, no session, no git: nothing on the page can run
 * anything. A task's comment composer is collaboration, and stays.
 */
async function countExecutionControls(page: Page): Promise<number> {
  return (await page.locator('[data-testid="input-toolbar"], .side-panel-root, .sidebar-header-desktop, [data-testid="new-session"], [data-testid^="git-"]').count())
    + (await page.getByRole('button', { name: /run on/i }).count())
    + (await page.getByText('New session', { exact: true }).count())
}

/** Every route of the page shell: the shell, the rail, and no way to run anything. */
async function proveShell(page: Page, phone: boolean): Promise<void> {
  const where = phone ? 'phone' : 'laptop'
  const rail = phone ? page.getByTestId('page-strip') : page.getByTestId('page-rail')
  check(`[${where}] the page shell mounts on the tasks route`, (await page.getByTestId('page-shell').getAttribute('data-page')) === 'tasks')
  check(`[${where}] the rail shows Tasks · Works · Sessions`, await rail.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false)
    && (await rail.locator('a').allTextContents()).map((text) => text.trim()).join(' · ') === 'Tasks · Works · Sessions')
  check(`[${where}] the board renders`, await isVisible(page, '[data-testid="page-tasks"]'))
  check(`[${where}] no execution control is on the page`, (await countExecutionControls(page)) === 0)
}

/** A typed edit reaches the service: bob reads it back through his own socket. */
async function proveTypedEdit(page: Page, bob: LabClient, workId: string, sentence: string, where: string): Promise<void> {
  const editor = page.locator('.ProseMirror[contenteditable="true"]').first()
  check(`[${where}] the document is editable`, await editor.waitFor({ timeout: 20_000 }).then(() => true).catch(() => false))
  // The editor places the caret where it likes on focus; the DOM selection is put
  // at the end of the document, which ProseMirror reads back, so the line is appended.
  await editor.click()
  await page.waitForTimeout(500)
  await editor.evaluate((root) => {
    const range = document.createRange()
    range.selectNodeContents(root)
    range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await page.keyboard.press('Enter')
  await page.keyboard.type(sentence)
  const saved = await until(() => bob.rpc('loadWork', workId), (work) => work?.content?.includes(sentence) === true, 20_000)
  check(`[${where}] the typed edit is saved on the service (bob reads it)`, saved?.content?.includes(sentence) === true, JSON.stringify(saved?.content?.slice(0, 200)))
}

async function main(): Promise<number> {
  mkdirSync(ARTIFACTS, { recursive: true })
  if (process.env.SKIP_APP_BUILD === '1' && existsSync(join(APP_DIR, 'index.html'))) {
    console.log(`== reusing the web client build at ${APP_DIR}`)
  } else {
    console.log('== building the web client under /app/')
    const build = spawnSync('bun', ['run', 'build', '--base=/app/', '--outDir', APP_DIR, '--emptyOutDir'], { cwd: resolve(ROOT, 'apps/client'), stdio: 'pipe' })
    if (build.status !== 0) {
      console.error(build.stderr.toString())
      throw new Error('the web client build failed')
    }
  }

  const issuer = new LabIssuer()
  await issuer.start()
  const service = await bootWorkspaceService({ issuer, engine: 'sqlite', entry: process.env.SOLUS_LAB_ENTRY })
  issuer.setWorkspaceRoute(service.url)
  console.log(`== workspace service pid ${service.pid} · data ${service.dataDir} · ${service.url}`)
  const { server: originServer, origin } = await startOrigin(issuer, service)
  console.log(`== origin ${origin}`)
  const projectDir = mkdtempSync(join(tmpdir(), 'solus-lab-cloud-project-'))
  const alice = workspaceClient('alice', issuer, service)
  const bob = workspaceClient('bob', issuer, service)
  const browser = await chromium.launch()
  let runner: LabHost | null = null
  let owner: LabClient | null = null
  const tempDirs = [service.dataDir, projectDir]
  try {
    if (!(await alice.connect()).ok) throw new Error('alice could not reach the workspace service')
    if (!(await bob.connect()).ok) throw new Error('bob could not reach the workspace service')

    console.log('== 1. the tasks route on a laptop, every runner off')
    const laptop = await signedInContext(browser, origin, false)
    const board = await openPage(laptop, origin, `#/w/${ORGANIZATION_ID}/tasks`)
    await proveShell(board, false)
    check('[laptop] the board is empty', (await board.locator('[data-task-card], [data-selected]').count()) === 0)
    await board.screenshot({ path: join(ARTIFACTS, 'cloud-page-tasks-empty.png') })

    console.log('== 2. a task, made from the page, appears without a reload')
    const taskTitle = 'Plan the launch from the page'
    const newTask = board.getByRole('button', { name: 'New task' }).first()
    let taskId: string | null = null
    if (await newTask.isVisible().catch(() => false)) {
      await newTask.click()
      const title = board.getByLabel('Task title')
      await title.waitFor({ timeout: 10_000 })
      await title.fill(taskTitle)
      await title.press('Enter')
      console.log('   the board has a composer; the task was typed there')
    } else {
      const created = await alice.rpc('tasksCreate', { title: taskTitle, projectKey: projectDir })
      taskId = created.id
      console.log('   the board has no composer; the task was made through alice\'s socket')
    }
    const onBoard = await board.getByText(taskTitle).first().waitFor({ timeout: 20_000 }).then(() => true).catch(() => false)
    check('[laptop] the task appears on the board without a reload', onBoard, JSON.stringify((await board.getByTestId('page-main').textContent())?.slice(0, 300)))
    await board.screenshot({ path: join(ARTIFACTS, 'cloud-page-tasks.png') })
    if (!taskId) {
      const listed = await until(() => alice.rpc('tasksList', {}), (result) => result.tasks.some((row) => row.title === taskTitle), 10_000)
      taskId = listed.tasks.find((row) => row.title === taskTitle)?.id ?? null
    }
    check('[laptop] the service holds the task', !!taskId)
    const taskPage = await openPage(laptop, origin, `#/w/${ORGANIZATION_ID}/tasks/${taskId}`)
    // The title is an editable field, so it is read as a value, not as text.
    check('[laptop] the task page renders', await isVisible(taskPage, '[data-testid="page-task"]') && (await taskPage.getByLabel('Task title').first().inputValue().catch(() => '')) === taskTitle)
    check('[laptop] the Share control is present on the task page', await isVisible(taskPage, '[data-testid="share-button"]'))
    check('[laptop] no execution control is on the task page', (await countExecutionControls(taskPage)) === 0)
    await taskPage.screenshot({ path: join(ARTIFACTS, 'cloud-page-task.png') })
    await taskPage.close()

    console.log('== 3. a document on the service, opened and edited from the page')
    const body = '# Hello cloud\n\nA document on the workspace service.'
    const work = await alice.rpc('createWork', 'Cloud proof document', 'doc', body, body, undefined, 'claude-code')
    const workPage = await openPage(laptop, origin, `#/w/${ORGANIZATION_ID}/works/${work.id}`)
    check('[laptop] the document renders', await workPage.getByText('Hello cloud').first().waitFor({ timeout: 20_000 }).then(() => true).catch(() => false))
    await proveTypedEdit(workPage, bob, work.id, 'A line typed on the laptop page.', 'laptop')
    check('[laptop] no execution control is on the document page', (await countExecutionControls(workPage)) === 0)
    await workPage.screenshot({ path: join(ARTIFACTS, 'cloud-page-document.png') })
    await workPage.close()

    console.log('== 4. the service side: no runner, no execution plane')
    const info = await alice.rpc('connectionsGetServerInfo')
    check('the service is the cloud, serving collaboration only', info.hostKind === 'cloud' && info.organizationId === ORGANIZATION_ID && info.roles.length === 1 && info.roles[0] === 'collaboration', JSON.stringify({ hostKind: info.hostKind, roles: info.roles }))
    check('no runner has reported a session', (await alice.rpc('sessionRecordList', {})).length === 0)
    const refused = await alice.rpc('createHeadlessSession', { prompt: 'x', provider: 'claude-code', modelId: null, reasoningEffort: 'medium', contextWindow: null, cwd: projectDir }).then(() => null, (error: unknown) => error)
    check('the service refuses to run a session (PLANE_DISABLED)', refused instanceof LabRpcError && refused.code === 'PLANE_DISABLED', refused instanceof Error ? refused.message : String(refused))

    console.log('== 5. a runner comes up; the agent\'s task lands on the open board')
    runner = await bootLabHost({ flavor: 'personal', issuer, hostId: RUNNER_HOST_ID, runnerOf: ORGANIZATION_ID })
    tempDirs.push(runner.dataDir)
    console.log(`== runner pid ${runner.pid} · data ${runner.dataDir}`)
    check('the runner minted a grant for the organization', await runnerLinked(runner, 20_000))
    owner = new LabClient({ persona: personaForHost('alice', 'personal'), hostUrl: runner.localUrl, issuer, hostId: runner.hostId, hostKind: 'personal', credentialFree: true })
    check('the owner reaches the runner locally', (await owner.connect()).ok)
    const started = await owner.rpc('createHeadlessSession', { prompt: 'cloud __MOCK_AGENT_TOOLS__', provider: 'claude-code', modelId: null, reasoningEffort: 'medium', contextWindow: null, cwd: projectDir, skipTaskCreation: true })
    const runnerTaskShown = await board.getByText(RUNNER_TASK_TITLE).first().waitFor({ timeout: 30_000 }).then(() => true).catch(() => false)
    check('the agent\'s task appears on alice\'s open board without a reload', runnerTaskShown, JSON.stringify((await board.getByTestId('page-main').textContent())?.slice(0, 300)))
    await board.screenshot({ path: join(ARTIFACTS, 'cloud-page-tasks-runner.png') })
    const recorded = await until(() => alice.rpc('sessionRecordList', {}), (list) => list.some((record) => record.sessionId === started.agentSessionId), 15_000)
    check('the service lists the runner\'s session, naming the runner', recorded.find((record) => record.sessionId === started.agentSessionId)?.runnerHostId === RUNNER_HOST_ID)
    owner.close()
    owner = null
    await runner.stop()
    runner = null
    console.log('== the runner is stopped; fresh page loads')
    const boardAfter = await openPage(laptop, origin, `#/w/${ORGANIZATION_ID}/tasks`)
    check('[laptop] the board opens fresh with both tasks after the runner stopped',
      await boardAfter.getByText(taskTitle).first().waitFor({ timeout: 20_000 }).then(() => true).catch(() => false)
      && await boardAfter.getByText(RUNNER_TASK_TITLE).first().isVisible().catch(() => false))
    await boardAfter.close()
    const workAfter = await openPage(laptop, origin, `#/w/${ORGANIZATION_ID}/works/${work.id}`)
    check('[laptop] the document opens fresh with the typed edit after the runner stopped', await workAfter.getByText('A line typed on the laptop page.').first().waitFor({ timeout: 20_000 }).then(() => true).catch(() => false))
    await workAfter.close()
    await board.close()
    await laptop.close()

    console.log('== 6. the same pages on a phone')
    const phone = await signedInContext(browser, origin, true)
    const phoneBoard = await openPage(phone, origin, `#/w/${ORGANIZATION_ID}/tasks`)
    await proveShell(phoneBoard, true)
    check('[phone] the board is readable: both tasks are on it',
      await phoneBoard.getByText(taskTitle).first().waitFor({ timeout: 20_000 }).then(() => true).catch(() => false)
      && await phoneBoard.getByText(RUNNER_TASK_TITLE).first().isVisible().catch(() => false))
    await phoneBoard.screenshot({ path: join(ARTIFACTS, 'cloud-page-tasks-phone.png') })
    await phoneBoard.close()
    const phoneWork = await openPage(phone, origin, `#/w/${ORGANIZATION_ID}/works/${work.id}`)
    check('[phone] the document renders', await phoneWork.getByText('Hello cloud').first().waitFor({ timeout: 20_000 }).then(() => true).catch(() => false))
    await proveTypedEdit(phoneWork, bob, work.id, 'A line typed on the phone.', 'phone')
    await phoneWork.screenshot({ path: join(ARTIFACTS, 'cloud-page-document-phone.png') })
    await phoneWork.close()
    await phone.close()
  } finally {
    alice.close()
    bob.close()
    owner?.close()
    await browser.close()
    originServer.close()
    await runner?.stop()
    await service.stop()
    await issuer.stop()
    if (process.env.KEEP === '1') console.log(`== kept: ${tempDirs.join(' ')}`)
    else for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  }
  console.log(`\n== ${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} failed check(s)`)
  return failures === 0 ? 0 : 1
}

process.exit(await main())
