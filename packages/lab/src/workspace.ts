import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import postgres from 'postgres'
import { z } from 'zod'
import type { LabIssuer } from './issuer'

/**
 * An isolated workspace service for the Lab (docs/plans/cloud-service-model.md
 * §15): the built standalone server in workspace mode on a temporary data
 * directory, trusting the Lab issuer for `solus-workspace` grants. SQLite by
 * default, so the Lab needs no Docker; Postgres when a database URL is given,
 * one fresh database per run. It never sees `~/.solus`.
 */

export type WorkspaceEngine = 'sqlite' | 'postgres'

export interface WorkspaceServiceOptions {
  issuer: Pick<LabIssuer, 'issuer' | 'jwksUrl'>
  engine: WorkspaceEngine
  /** Required for `postgres`: an empty database this service may migrate. */
  databaseUrl?: string
  /** Path to `dist/main/standalone.js`; defaults to the worktree's build. */
  entry?: string
  tempRoot?: string
  /** Base64 of 32 random bytes: the credential vault's key (cloud-service-model.md §5). Absent means no vault. */
  vaultKey?: string
}

export interface WorkspaceService {
  readonly engine: WorkspaceEngine
  readonly dataDir: string
  /** The one listener: grants only; there is no tunnel and no local owner. */
  readonly url: string
  readonly pid: number
  readonly logPath: string
  stop(): Promise<void>
}

const lockFileSchema = z.object({ port: z.number().int().positive(), host: z.string() })

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

export async function bootWorkspaceService(options: WorkspaceServiceOptions): Promise<WorkspaceService> {
  const entry = options.entry ?? resolve(process.cwd(), 'dist/main/standalone.js')
  if (!existsSync(entry)) throw new Error(`No standalone build at ${entry}; run \`bun run build:test\` first.`)
  if (options.engine === 'postgres' && !options.databaseUrl) throw new Error('A Postgres workspace service needs databaseUrl')
  const dataDir = mkdtempSync(join(options.tempRoot ?? tmpdir(), `solus-lab-workspace-${options.engine}-`))
  assertTemporary(dataDir)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SOLUS_DATA_DIR: dataDir,
    SOLUS_PORT: '0',
    SOLUS_NO_LAN_DISCOVERY: '1',
    SOLUS_WORKSPACE: '1',
    SOLUS_ROLES: 'collaboration',
    SOLUS_CLOUD_ISSUER: options.issuer.issuer,
    SOLUS_CLOUD_JWKS_URL: options.issuer.jwksUrl,
    SOLUS_DB: options.engine,
    DATABASE_URL: options.engine === 'postgres' ? options.databaseUrl : '',
  }
  if (options.vaultKey) env.SOLUS_VAULT_KEY = options.vaultKey
  else delete env.SOLUS_VAULT_KEY
  // No managed link, no host token: a workspace service is nobody's machine.
  delete env.SOLUS_MANAGED
  delete env.SOLUS_MANAGED_LINK
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

  const lockFile = join(dataDir, 'server.lock')
  await waitFor(async () => exited || existsSync(lockFile), 30_000, 'the workspace service lock file')
  if (exited) throw new Error(`The workspace service exited at boot; see ${logPath}`)
  const lock = lockFileSchema.parse(JSON.parse(readFileSync(lockFile, 'utf8')))
  const url = `http://127.0.0.1:${lock.port}`
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
