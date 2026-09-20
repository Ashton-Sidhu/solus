/**
 * The guest-link proof (docs/plans/multiplayer-sharing.md §4.2): a share link opened
 * in a browser lands a visitor with no account on the one shared resource, through a
 * workspace service ticket door, and loses it the moment the link is regenerated.
 *
 * The Lab issuer stands in for Solus cloud. A small origin serves the built web client
 * under `/app/` and mints guest grants at `/v1/workspace/guest-grant`, exactly as the
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
import { chromium, type Browser, type Page } from 'playwright'
import { z } from 'zod'
import { bootWorkspaceService, type WorkspaceService } from '@solus/lab/workspace'
import { WORKSPACE_AUDIENCE } from '@solus/contracts/uplink'
import { LabClient } from '@solus/lab/client'
import { LabIssuer } from '@solus/lab/issuer'
import { personaForHost } from '@solus/lab/personas'
import { cloudShareUrl, type ShareResource } from '@solus/contracts/sharing'

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
function startOrigin(issuer: LabIssuer, host: WorkspaceService): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const guestGrant = url.pathname === '/v1/workspace/guest-grant'
    if (request.method === 'POST' && guestGrant) {
      let body = ''
      request.on('data', (chunk: Buffer) => { body += chunk.toString() })
      request.on('end', () => {
        const parsed = guestRequestSchema.safeParse(body ? JSON.parse(body) : {})
        if (!parsed.success) {
          response.statusCode = parsed.success ? 404 : 400
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify({ error: parsed.success ? 'host_not_found' : 'invalid_request' }))
          return
        }
        const guestId = parsed.data.guestId ?? 'web-guest-0123456789abcd'
        const displayName = parsed.data.displayName?.trim() || 'Guest'
        const grant = issuer.mint({ id: 'web-guest', kind: 'guest', guestId, displayName }, { hostId: WORKSPACE_AUDIENCE, hostKind: 'cloud' })
        response.setHeader('content-type', 'application/json')
        response.setHeader('cache-control', 'no-store')
        response.end(JSON.stringify({ grant, hostId: WORKSPACE_AUDIENCE, expiresAt: Date.now() + 600_000, guestId, displayName, routes: [{ kind: 'tunnel', url: host.url }] }))
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

async function landAsGuest(page: Page, origin: string, resource: ShareResource, secret: string, name: string): Promise<string[]> {
  const refused: string[] = []
  page.on('console', (message) => {
    const text = message.text()
    if (/FORBIDDEN|not available to a guest|not shared with you/.test(text)) refused.push(text)
  })
  await page.goto(cloudShareUrl(origin, resource, secret))
  await page.getByTestId('guest-name').waitFor({ timeout: 15_000 })
  await page.getByTestId('guest-name').fill(name)
  await page.getByTestId('guest-continue').click()
  await page.getByTestId('guest-shell').waitFor({ timeout: 20_000 })
  return refused
}


async function main(): Promise<void> {
  mkdirSync(ARTIFACTS, { recursive: true })
  const built = spawnSync('bun', ['run', 'vite', 'build', '--base=/app/', `--outDir=${APP_DIR}`], { cwd: join(ROOT, 'apps/client'), stdio: 'inherit' })
  if (built.status !== 0) throw new Error('Client build failed')
  const issuer = new LabIssuer()
  await issuer.start()
  const service = await bootWorkspaceService({ issuer, engine: 'sqlite', entry: process.env.SOLUS_LAB_ENTRY })
  const account = await startOrigin(issuer, service)
  const alice = new LabClient({ persona: personaForHost('alice', 'managed'), hostUrl: service.url, issuer, hostId: WORKSPACE_AUDIENCE, hostKind: 'cloud' })
  let browser: Browser | null = null
  try {
    if (!(await alice.connect()).ok) throw new Error('Owner could not connect')
    const work = await alice.rpc('createWork', 'Cloud guest proof', 'doc', '# Available with no runner', '', undefined, 'claude-code', service.dataDir)
    const resource = { kind: 'work', id: work.id } as const
    const link = (await alice.rpc('shareSetLink', { resource, role: 'viewer' }))!
    browser = await chromium.launch({ headless: true })
    for (const phone of [false, true]) {
      const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 }, isMobile: phone, hasTouch: phone })
      try {
        const page = await context.newPage()
        await landAsGuest(page, account.origin, resource, link.secret, 'Maya')
        await page.getByText('Available with no runner', { exact: true }).first().waitFor()
        check(`${phone ? 'phone' : 'laptop'}: cloud document opens with no runner`, true)
        check('viewer has no editable document', await page.locator('[contenteditable="true"]').count() === 0)
        await page.screenshot({ path: join(ARTIFACTS, `guest-cloud-${phone ? 'phone' : 'laptop'}.png`) })
        if (phone) {
          await alice.rpc('shareSetLink', { resource, role: 'viewer', regenerate: true })
          await page.getByText('This link no longer works', { exact: true }).waitFor()
          check('regeneration closes the open guest resource', true)
          await page.reload()
          await page.getByTestId('guest-continue').click()
          await page.getByText('This link no longer works', { exact: true }).waitFor()
          check('the old link cannot reconnect', true)
        }
      } finally { await context.close() }
    }
  } finally {
    await browser?.close()
    alice.close()
    await new Promise<void>((resolveClose) => account.server.close(() => resolveClose()))
    await service.stop()
    await issuer.stop()
  }
  if (failures) process.exitCode = 1
}
await main()
