import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import postgres from 'postgres'
import type { LabIssuer } from './issuer'

/**
 * An isolated workspace service for the Lab (docs/plans/cloud-service-model.md
 * §15): the built standalone server in API mode on a temporary data
 * directory, trusting the Lab issuer for `solus-api` grants. SQLite by
 * default, so the Lab needs no Docker; Postgres when a database URL is given,
 * one fresh database per run. It never sees `~/.solus`.
 */

export type SolusApiEngine = 'sqlite' | 'postgres'

export interface LabSolusApiOptions {
  issuer: Pick<LabIssuer, 'issuer' | 'jwksUrl'>
  engine: SolusApiEngine
  /** Required for `postgres`: an empty database this service may migrate. */
  databaseUrl?: string
  /** Path to `dist/main/standalone.js`; defaults to the worktree's build. */
  entry?: string
  tempRoot?: string
}

export interface LabSolusApi {
  readonly engine: SolusApiEngine
  readonly dataDir: string
  /** The one listener: grants only; there is no tunnel and no local owner. */
  readonly url: string
  readonly pid: number
  readonly logPath: string
  stop(): Promise<void>
}

function assertTemporary(dir: string): void {
  const roots = [tmpdir(), resolve(process.cwd(), '.solus-local')]
  if (!roots.some((root) => dir.startsWith(root))) {
    throw new Error(`The Lab refuses a data directory outside a temp location: ${dir}`)
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

export async function bootLabSolusApi(options: LabSolusApiOptions): Promise<LabSolusApi> {
  const entry = options.entry ?? process.env.SOLUS_LAB_ENTRY ?? resolve(process.cwd(), 'dist/main/standalone.js')
  if (!existsSync(entry)) throw new Error(`No standalone build at ${entry}; run \`bun run build:test\` first.`)
  if (options.engine === 'postgres' && !options.databaseUrl) throw new Error('A Postgres workspace service needs databaseUrl')
  const dataDir = mkdtempSync(join(options.tempRoot ?? tmpdir(), `solus-lab-workspace-${options.engine}-`))
  assertTemporary(dataDir)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SOLUS_DATA_DIR: dataDir,
    SOLUS_PORT: '0',
    SOLUS_NO_LAN_DISCOVERY: '1',
    SOLUS_API: '1',
    SOLUS_ROLES: 'collaboration',
    SOLUS_CLOUD_ISSUER: options.issuer.issuer,
    SOLUS_CLOUD_JWKS_URL: options.issuer.jwksUrl,
    SOLUS_DB: options.engine,
    // One service, one run: a fresh key is the replicas' shared one.
    SOLUS_API_SIGNING_KEY: randomBytes(32).toString('base64'),
    DATABASE_URL: options.engine === 'postgres' ? options.databaseUrl : '',
  }
  // No managed link, no host token: a workspace service is nobody's machine.
  delete env.SOLUS_HOST_LINK
  const logDir = join(dataDir, 'lab')
  mkdirSync(logDir, { recursive: true })
  const logPath = join(logDir, 'workspace.log')
  const output = openSync(logPath, 'w')
  const child: ChildProcess = spawn(process.execPath.endsWith('bun') ? 'node' : process.execPath, [entry, '--data-dir', dataDir], {
    cwd: dataDir,
    env,
    stdio: ['ignore', output, output],
  })
  const pid = child.pid
  if (!pid) throw new Error('The Lab workspace service did not start')
  let exited = false
  child.once('exit', () => { exited = true })

  // The workspace service takes no single-instance lock; it prints where it listens.
  const reachable = () => /Solus API reachable at (http:\/\/[^\s]+)/.exec(readFileSync(logPath, 'utf8'))?.[1]
  await waitFor(async () => exited || reachable() !== undefined, 30_000, 'the workspace service address')
  if (exited) throw new Error(`The workspace service exited at boot; see ${logPath}`)
  const url = reachable()!
  await waitFor(async () => {
    try { return (await fetch(`${url}/health`)).ok } catch { return false }
  }, 30_000, 'the workspace service to answer /health')

  return {
    engine: options.engine,
    dataDir,
    url,
    pid,
    logPath,
    stop: async () => {
      if (exited) return
      // Only the PID this Lab started, never a name match.
      child.kill('SIGTERM')
      await Promise.race([
        new Promise<void>((r) => child.once('exit', () => r())),
        new Promise<void>((r) => setTimeout(r, 10_000)),
      ])
      if (!exited) child.kill('SIGKILL')
    },
  }
}

export interface LabDatabase {
  url: string
  drop(): Promise<void>
}

/** One empty Postgres database for one workspace run, on the server `POSTGRES_ADMIN_URL` names; dropped after. */
export async function createLabDatabase(adminUrl: string): Promise<LabDatabase> {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
  const name = `solus_lab_${Date.now().toString(36)}_${process.pid}`
  await admin.unsafe(`CREATE DATABASE "${name}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  return {
    url: url.toString(),
    drop: async () => {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      await admin.end()
    },
  }
}
