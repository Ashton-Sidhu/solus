import { spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { bootLabHost } from './host'
import { bootLabSolusApi } from './solus-api'

/**
 * The Lab's local Solus cloud (cloud mode): the account site of the sibling
 * `solus-cloud` checkout under `vite dev`, on an embedded Postgres (PGlite served on the
 * wire protocol by `pglite-server.ts`) with the cloud's own migrations, and one Lab host
 * from the Lab build, registered to no account yet. No Docker, no production, no
 * real mail: the cloud runs in development, with the console mailer, stub tunnels, and
 * in-memory managed hosts. Beside it runs the Solus API (the record service: the Lab
 * build in API mode, on its own SQLite file), which trusts the cloud as its issuer and
 * is the cloud's `SOLUS_API_URL`, so organization work has a home.
 *
 * `bun lab up --cloud` starts it and leaves it running; the facts go to
 * `.solus-local/lab-cloud/stack.json`. `bun lab down` stops exactly the processes `up`
 * started, keeps their logs under `.solus-local/lab-cloud/evidence/`, and removes the
 * scratch data.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
export const LAB_CLOUD_DIR = resolve(REPO_ROOT, '.solus-local/lab-cloud')
export const STACK_FILE = join(LAB_CLOUD_DIR, 'stack.json')

const personaFactsSchema = z.object({
  email: z.string(),
  password: z.string(),
  name: z.string(),
  userId: z.string(),
  /** The organization the persona works in: alice and bob in `lab`, carol in `elsewhere`. */
  organizationId: z.string(),
  organizationRole: z.enum(['owner', 'member']),
})
export type CloudPersona = z.infer<typeof personaFactsSchema>

export const stackSchema = z.object({
  version: z.literal(1),
  startedAt: z.string(),
  cloudDir: z.string(),
  origin: z.string(),
  databaseUrl: z.string(),
  scratchDir: z.string(),
  evidenceDir: z.string(),
  processes: z.array(z.object({ name: z.string(), pid: z.number().int().positive(), log: z.string() })),
  host: z.object({
    dataDir: z.string(),
    localUrl: z.string(),
    tunnelUrl: z.string(),
    pid: z.number().int().positive(),
    devLog: z.string(),
  }),
  /** The Solus API the cloud names (`SOLUS_API_URL`); it admits the cloud's tokens for `urn:solus:api`. */
  solusApi: z.object({ url: z.string(), dataDir: z.string(), pid: z.number().int().positive(), devLog: z.string() }),
  /** The life of the cloud's account, Solus API, and control tokens: shorter than five minutes in the Lab (development only). */
  accessTokenTtlSeconds: z.number().int().positive(),
  organizations: z.object({ lab: z.string(), elsewhere: z.string() }),
  personas: z.object({ alice: personaFactsSchema, bob: personaFactsSchema, carol: personaFactsSchema }),
})
export type LocalCloudStack = z.infer<typeof stackSchema>
export type CloudPersonaId = keyof LocalCloudStack['personas']

export function readStack(): LocalCloudStack {
  if (!existsSync(STACK_FILE)) throw new Error(`No local cloud is up (${STACK_FILE}); run \`bun lab up --cloud\` first.`)
  return stackSchema.parse(JSON.parse(readFileSync(STACK_FILE, 'utf8')))
}

const addressSchema = z.object({ port: z.number().int().positive() })

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = addressSchema.safeParse(server.address())
      server.close(() => resolvePort(address.success ? address.data.port : 0))
    })
  })
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

/** A process `up` leaves running: its own process group, output to a log file, not waited for. */
function startDetached(name: string, command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; log: string }): { name: string; pid: number; log: string } {
  const output = openSync(options.log, 'w')
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', output, output], detached: true })
  if (!child.pid) throw new Error(`${name} did not start`)
  child.unref()
  return { name, pid: child.pid, log: options.log }
}

/** Every key the checkout's own env files set, so the Lab can blank the ones it does not set (a mail key must never apply). */
function envFileKeys(cloudDir: string): string[] {
  const keys = new Set<string>()
  for (const file of ['.env', '.env.local', '.env.development', '.env.development.local']) {
    const path = join(cloudDir, file)
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
      if (match) keys.add(match[1]!)
    }
  }
  return [...keys]
}

/**
 * The account plane's access-token life in the Lab: development only (solus-cloud
 * `DEVELOPMENT_ACCESS_TOKEN_TTL_SECONDS`). A host replaces a token in its last minute,
 * so a sign-out reaches it within 30 s, not four minutes. Host tokens keep five minutes.
 */
const LAB_ACCESS_TOKEN_TTL_SECONDS = 90
/**
 * The OAuth app credentials the cloud's provider fixture accepts, and the code its
 * token endpoint takes; the fixture answers GitHub's `/user` as `proof-alice`.
 */
export const LAB_PROVIDER_CLIENT = { id: 'proof-client', secret: 'proof-secret', code: 'proof-code', githubLogin: 'proof-alice' } as const

/** Stops the PIDs, as process groups, that a stack recorded. Only those. */
export function stopProcesses(processes: ReadonlyArray<{ name: string; pid: number }>): void {
  for (const entry of processes) {
    try {
      process.kill(-entry.pid, 'SIGTERM')
    } catch {
      try { process.kill(entry.pid, 'SIGTERM') } catch { /* already gone */ }
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function startLocalCloud(): Promise<LocalCloudStack> {
  if (existsSync(STACK_FILE)) throw new Error(`A local cloud is up already (${STACK_FILE}); run \`bun lab down\` first.`)
  const cloudDir = resolve(process.env.SOLUS_CLOUD_DIR ?? resolve(REPO_ROOT, '../solus-cloud'))
  if (!existsSync(join(cloudDir, 'drizzle.config.ts'))) throw new Error(`No solus-cloud checkout at ${cloudDir}; set SOLUS_CLOUD_DIR.`)
  const startedAt = new Date().toISOString()
  const scratchDir = mkdtempSync(join(tmpdir(), 'solus-lab-cloud-'))
  const evidenceDir = join(LAB_CLOUD_DIR, 'evidence', startedAt.replace(/[:.]/g, '-'))
  mkdirSync(evidenceDir, { recursive: true })
  const processes: LocalCloudStack['processes'] = []
  // A failure part way stops what started and keeps its logs.
  const abandon = (error: unknown): never => {
    stopProcesses(processes)
    throw error
  }
  try {
    const pgPort = await freePort()
    const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${pgPort}/postgres`
    const pglite = startDetached('pglite', process.execPath, [resolve(import.meta.dirname, 'pglite-server.ts'), cloudDir, join(scratchDir, 'pgdata'), String(pgPort)], {
      cwd: scratchDir, env: { ...process.env }, log: join(evidenceDir, 'pglite.log'),
    })
    processes.push(pglite)
    await waitFor(async () => readFileSync(pglite.log, 'utf8').includes('pglite_listening') || !isAlive(pglite.pid), 30_000, 'PGlite to listen')
    if (!isAlive(pglite.pid)) throw new Error(`PGlite exited; see ${pglite.log}`)

    // The cloud's own migration path, as a deploy runs it.
    const migrated = spawnSync('bun', ['run', 'db:migrate'], { cwd: cloudDir, env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8' })
    writeFileSync(join(evidenceDir, 'migrate.log'), `${migrated.stdout}\n${migrated.stderr}`)
    if (migrated.status !== 0) throw new Error(`The cloud migrations failed; see ${join(evidenceDir, 'migrate.log')}`)

    const cloudPort = await freePort()
    const origin = `http://localhost:${cloudPort}`
    // The Solus API's port is chosen first: the cloud names it at start, and a host's registration keeps it.
    const apiPort = await freePort()
    const solusApiUrl = `http://127.0.0.1:${apiPort}`
    // The Solus API's own client key: the cloud registers its public half as `solus-api`.
    const solusApiClientKey = JSON.stringify(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }))
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const key of envFileKeys(cloudDir)) env[key] = ''
    Object.assign(env, {
      ENVIRONMENT: 'development',
      APP_ORIGIN: origin,
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
      INTEGRATION_VAULT_KEY: randomBytes(32).toString('base64'),
      SOLUS_API_CLIENT_KEY: solusApiClientKey,
      SOLUS_API_URL: solusApiUrl,
      DEVELOPMENT_ACCESS_TOKEN_TTL_SECONDS: String(LAB_ACCESS_TOKEN_TTL_SECONDS),
      // Development defaults, named so a reader sees them: console mail, stub tunnels, in-memory managed hosts.
      RESEND_API_KEY: '',
      CLOUDFLARE_ACCOUNT_ID: '',
      CLOUDFLARE_ZONE_ID: '',
      CLOUDFLARE_API_TOKEN: '',
      SPRITES_API_TOKEN: '',
      // Managed hosts need a named release; the in-memory provider never downloads it.
      MANAGED_HOST_RELEASE: '0.33.0',
      // The cloud's own fake of the GitHub, Google, and Atlassian OAuth apps (solus-cloud
      // `scripts/e2e/integration-provider-fixture.mjs`, loaded below): a website sign-in
      // to a provider completes with no real provider and no real credential.
      SOLUS_INTEGRATION_PROOF: '1',
      ...Object.fromEntries(['GITHUB', 'GOOGLE', 'ATLASSIAN'].flatMap((provider) => [
        [`INTEGRATION_${provider}_CLIENT_ID`, LAB_PROVIDER_CLIENT.id],
        [`INTEGRATION_${provider}_CLIENT_SECRET`, LAB_PROVIDER_CLIENT.secret],
      ])),
      VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true',
    })
    const providerFixture = join(cloudDir, 'scripts/e2e/integration-provider-fixture.mjs')
    const cloud = startDetached('cloud', 'node', ['--import', providerFixture, join(cloudDir, 'node_modules/vite/bin/vite.js'), 'dev', '--port', String(cloudPort), '--strictPort'], {
      cwd: cloudDir, env, log: join(evidenceDir, 'cloud.log'),
    })
    processes.push(cloud)
    // The first request compiles the server routes.
    await waitFor(async () => {
      if (!isAlive(cloud.pid)) throw new Error(`The cloud dev server exited; see ${cloud.log}`)
      try { return (await fetch(`${origin}/.well-known/openid-configuration`)).ok } catch { return false }
    }, 180_000, 'the cloud to answer its OpenID discovery')

    // The record service as production runs it beside the account site (solus-cloud
    // `src/server/main.ts`): API mode, the cloud as its one issuer, the cloud's
    // `solus-api` client key. Its own SQLite file, as the Lab's other Solus API runs.
    const api = await bootLabSolusApi({
      issuer: { issuer: origin, jwksUrl: `${origin}/api/auth/jwks` },
      engine: 'sqlite',
      port: apiPort,
      clientKey: solusApiClientKey,
      tempRoot: scratchDir,
      longLived: true,
    })
    processes.push({ name: 'solus-api', pid: api.pid, log: api.logPath })
    if (new URL(api.url).port !== String(apiPort)) throw new Error(`The Solus API listens at ${api.url}, not on port ${apiPort}`)

    const seeded = await seedPersonas(origin, cloud.log)

    const host = await bootLabHost({ flavor: 'personal', unregistered: true, longLived: true })
    processes.push({ name: 'host', pid: host.pid, log: host.logPath })

    const stack: LocalCloudStack = {
      version: 1,
      startedAt,
      cloudDir,
      origin,
      databaseUrl,
      scratchDir,
      evidenceDir,
      processes,
      host: { dataDir: host.dataDir, localUrl: host.localUrl, tunnelUrl: host.tunnelUrl, pid: host.pid, devLog: join(host.dataDir, 'dev.log') },
      solusApi: { url: solusApiUrl, dataDir: api.dataDir, pid: api.pid, devLog: join(api.dataDir, 'dev.log') },
      accessTokenTtlSeconds: LAB_ACCESS_TOKEN_TTL_SECONDS,
      ...seeded,
    }
    mkdirSync(LAB_CLOUD_DIR, { recursive: true })
    writeFileSync(STACK_FILE, `${JSON.stringify(stack, null, 2)}\n`, { mode: 0o600 })
    return stack
  } catch (error) {
    return abandon(error)
  }
}

/** Stops what `up` started, keeps the logs as evidence, and removes the scratch data. */
export async function stopLocalCloud(): Promise<LocalCloudStack> {
  const stack = readStack()
  // The host first: it may still write to its log while it stops.
  const host = stack.processes.filter((entry) => entry.name === 'host')
  stopProcesses(host)
  await waitFor(async () => host.every((entry) => !isAlive(entry.pid)), 15_000, 'the host to stop').catch(() => stopKill(host))
  const others = stack.processes.filter((entry) => entry.name !== 'host')
  stopProcesses(others)
  await waitFor(async () => others.every((entry) => !isAlive(entry.pid)), 15_000, 'the cloud to stop').catch(() => stopKill(others))
  const hostEvidence = join(stack.evidenceDir, 'host')
  mkdirSync(hostEvidence, { recursive: true })
  for (const file of ['dev.log', 'lab']) {
    const source = join(stack.host.dataDir, file)
    if (existsSync(source)) cpSync(source, join(hostEvidence, file), { recursive: true })
  }
  const apiEvidence = join(stack.evidenceDir, 'solus-api')
  mkdirSync(apiEvidence, { recursive: true })
  for (const file of ['dev.log', 'lab']) {
    const source = join(stack.solusApi.dataDir, file)
    if (existsSync(source)) cpSync(source, join(apiEvidence, file), { recursive: true })
  }
  writeFileSync(join(stack.evidenceDir, 'stack.json'), `${JSON.stringify(stack, null, 2)}\n`)
  rmSync(stack.scratchDir, { recursive: true, force: true })
  rmSync(stack.host.dataDir, { recursive: true, force: true })
  rmSync(STACK_FILE, { force: true })
  return stack
}

function stopKill(processes: ReadonlyArray<{ pid: number }>): void {
  for (const entry of processes) {
    try { process.kill(-entry.pid, 'SIGKILL') } catch { try { process.kill(entry.pid, 'SIGKILL') } catch { /* gone */ } }
  }
}

// ── Personas as real accounts ──────────────────────────────────────────────

const sessionSchema = z.object({ user: z.object({ id: z.string().min(1) }) }).nullable()
const organizationListSchema = z.array(z.object({ id: z.string(), name: z.string(), metadata: z.unknown().optional() }))
const invitationSchema = z.object({ id: z.string().min(1) })

/** A Better Auth call from a browser on the account origin. */
export async function accountCall(origin: string, path: string, init: { method?: string; body?: object; cookie?: string } = {}): Promise<Response> {
  const headers = new Headers({ origin, accept: 'application/json', connection: 'close' })
  if (init.body) headers.set('content-type', 'application/json')
  if (init.cookie) headers.set('cookie', init.cookie)
  return fetch(`${origin}${path}`, { method: init.method ?? (init.body ? 'POST' : 'GET'), headers, body: init.body ? JSON.stringify(init.body) : undefined, redirect: 'manual' })
}

/** The `name=value` pairs a response sets, as a cookie header. */
export function cookieOf(response: Response): string {
  return response.headers.getSetCookie().map((entry) => entry.split(';')[0]!).filter((pair) => pair && !pair.endsWith('=')).join('; ')
}

/** The verification link the console mailer printed last for this address. */
function verificationLink(cloudLog: string, email: string): string | null {
  const log = readFileSync(cloudLog, 'utf8')
  const start = log.lastIndexOf(`to: '${email}'`)
  if (start < 0) return null
  return /https?:\/\/[^\s"'\\]+verify-email[^\s"'\\]+/.exec(log.slice(start))?.[0] ?? null
}

/** Sign-up with email and password, verified through the console mailer, as a person does it. */
async function signUp(origin: string, cloudLog: string, name: string, email: string, password: string): Promise<{ cookie: string; userId: string }> {
  // The cloud checks each new password with a breach service over the network; its
  // failure is a 5xx, and asking again a moment later is what a person does.
  let response = await accountCall(origin, '/api/auth/sign-up/email', { body: { name, email, password } })
  for (let attempt = 1; response.status >= 500 && attempt < 4; attempt++) {
    await new Promise((r) => setTimeout(r, 1_000 * attempt))
    response = await accountCall(origin, '/api/auth/sign-up/email', { body: { name, email, password } })
  }
  if (!response.ok) throw new Error(`${name}'s sign-up answered ${response.status}: ${await response.text()}`)
  const deadline = Date.now() + 15_000
  let link = verificationLink(cloudLog, email)
  while (!link && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
    link = verificationLink(cloudLog, email)
  }
  if (!link) throw new Error(`No verification mail to ${email} in ${cloudLog}`)
  const verified = await fetch(link, { redirect: 'manual' })
  const cookie = cookieOf(verified)
  const session = sessionSchema.parse(await (await accountCall(origin, '/api/auth/get-session', { cookie })).json())
  if (!session) throw new Error(`${name} has no session after verification`)
  return { cookie, userId: session.user.id }
}

/** Sign-up made the person's first organization with a pending name; name it, as the welcome step does. */
async function nameFirstOrganization(origin: string, cookie: string, name: string): Promise<string> {
  const organizations = organizationListSchema.parse(await (await accountCall(origin, '/api/auth/organization/list', { cookie })).json())
  const first = organizations[0]
  if (!first) throw new Error('Sign-up made no first organization')
  const response = await accountCall(origin, '/api/auth/organization/update', { cookie, body: { organizationId: first.id, data: { name, metadata: {} } } })
  if (!response.ok) throw new Error(`Naming the organization answered ${response.status}`)
  return first.id
}

/**
 * alice signs up and names her organization "Lab"; she invites bob, who signs up into
 * it and accepts; carol signs up and names hers "Elsewhere". All through the account
 * site's own HTTP routes; the only shortcut is reading the verification mail from the
 * console mailer's log.
 */
async function seedPersonas(origin: string, cloudLog: string): Promise<Pick<LocalCloudStack, 'organizations' | 'personas'>> {
  const stamp = Date.now().toString(36)
  const account = (name: string) => ({ name, email: `${name.toLowerCase()}-${stamp}@lab.solus.test`, password: `lab-${name.toLowerCase()}-${randomBytes(9).toString('base64url')}` })
  const alice = account('Alice')
  const bob = account('Bob')
  const carol = account('Carol')

  const aliceSession = await signUp(origin, cloudLog, alice.name, alice.email, alice.password)
  const lab = await nameFirstOrganization(origin, aliceSession.cookie, 'Lab')
  const invited = await accountCall(origin, '/api/auth/organization/invite-member', { cookie: aliceSession.cookie, body: { email: bob.email, role: 'member', organizationId: lab } })
  if (!invited.ok) throw new Error(`Inviting bob answered ${invited.status}: ${await invited.text()}`)
  const invitation = invitationSchema.parse(await invited.json())
  const bobSession = await signUp(origin, cloudLog, bob.name, bob.email, bob.password)
  const accepted = await accountCall(origin, '/api/auth/organization/accept-invitation', { cookie: bobSession.cookie, body: { invitationId: invitation.id } })
  if (!accepted.ok) throw new Error(`bob's acceptance answered ${accepted.status}: ${await accepted.text()}`)
  const carolSession = await signUp(origin, cloudLog, carol.name, carol.email, carol.password)
  const elsewhere = await nameFirstOrganization(origin, carolSession.cookie, 'Elsewhere')

  return {
    organizations: { lab, elsewhere },
    personas: {
      alice: { ...alice, userId: aliceSession.userId, organizationId: lab, organizationRole: 'owner' },
      bob: { ...bob, userId: bobSession.userId, organizationId: lab, organizationRole: 'member' },
      carol: { ...carol, userId: carolSession.userId, organizationId: elsewhere, organizationRole: 'owner' },
    },
  }
}
