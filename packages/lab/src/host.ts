import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { MANAGED_LINK_ENV, type EnrollHostResponse, type HostKind } from '@solus/contracts/uplink'
import type { LabIssuer } from './issuer'

/**
 * An isolated headless Solus host for the Lab (plan §8.1, §8.8). It boots the built
 * standalone server on a temporary data directory, linked to the Lab issuer by a
 * hand-written link record, so its proxied listener admits only grants and its
 * verifier trusts only the Lab's key. It never sees `~/.solus`.
 */

export interface LabHostOptions {
  flavor: HostKind
  /** The Lab's own issuer, or a real control plane the host should trust instead. */
  issuer: Pick<LabIssuer, 'issuer' | 'jwksUrl'> & Partial<Pick<LabIssuer, 'issueManagedLink' | 'attachHostToOrganization'>>
  /** The host id the link names; defaults to the Lab's fixed id. A real cloud names its own. */
  hostId?: string
  /** Path to `dist/main/standalone.js`; defaults to the worktree's build. */
  entry?: string
  /** Where the temporary data directory is made; must be a temp location. */
  tempRoot?: string
  /**
   * How a managed host gets its link (docs/plans/managed-hosts.md §1–§2). `env` boots
   * the server in managed mode with no link record and the issuer's link in its
   * environment, so the host stores it the way a Fly machine does; `record` writes
   * the link record by hand as the personal flavor does. Defaults to `env` when the
   * issuer can issue links (the Lab's own), else `record` (a real cloud).
   */
  managedLink?: 'env' | 'record'
  /**
   * Boot the host as a runner of this organization (docs/plans/cloud-service-model.md
   * §16): the issuer issues it a real link with tokens, attaches it to the
   * organization, and the host's delivery mints a runner grant at boot. Personal
   * flavor only; the issuer must be the Lab's own.
   */
  runnerOf?: string
  /**
   * Boot on an existing data directory instead of a fresh one: how a scenario
   * restarts a host it stopped and proves what survived. Must be a temp location
   * this Lab made earlier.
   */
  dataDir?: string
}

export interface LabHost {
  readonly hostId: string
  readonly flavor: HostKind
  readonly dataDir: string
  /** The proxied listener: loopback on the wire, never trusted, grants only. */
  readonly tunnelUrl: string
  /** The ordinary listener: a trusted loopback caller is the local owner. */
  readonly localUrl: string
  readonly pid: number
  readonly logPath: string
  /** The link the host was started with in its environment; set only for a managed host in managed mode. */
  readonly managedLink: EnrollHostResponse | null
  /** True when the server runs in managed mode (`SOLUS_MANAGED=1`). */
  readonly managedMode: boolean
  /** Ends the process; `{ kill: true }` sends SIGKILL at once, the way a machine dies mid-turn. */
  stop(options?: { kill?: boolean }): Promise<void>
}

/** The Lab runs no tunnel: the connector gets a binary that only waits, never a real `cloudflared`. */
function writeConnectorShim(dataDir: string): void {
  const bin = join(dataDir, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'cloudflared'), '#!/bin/sh\nexec sleep 100000000\n', { mode: 0o755 })
}

const HOST_ID = 'labhostabcdefghi'
const linkFileSchema = z.object({ link: z.object({ proxiedPort: z.number().int().positive() }) })

/** A restarted host must bind the proxied port its link names, or its record would be stale. */
function restartProxiedPort(dataDir: string): number {
  const parsed = linkFileSchema.safeParse(JSON.parse(readFileSync(join(dataDir, 'uplink-link.json'), 'utf8')))
  if (!parsed.success) throw new Error(`The Lab cannot restart a host without a link record in ${dataDir}`)
  return parsed.data.link.proxiedPort
}
const lockFileSchema = z.object({ port: z.number().int().positive(), host: z.string() })
const addressSchema = z.object({ port: z.number().int().positive() })

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = addressSchema.safeParse(server.address())
      server.close(() => resolvePort(address.success ? address.data.port : 0))
    })
  })
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

export async function bootLabHost(options: LabHostOptions): Promise<LabHost> {
  const entry = options.entry ?? process.env.SOLUS_LAB_ENTRY ?? resolve(process.cwd(), 'dist/main/standalone.js')
  if (!existsSync(entry)) throw new Error(`No standalone build at ${entry}; run \`bun run build:test\` first.`)
  const tempRoot = options.tempRoot ?? tmpdir()
  const restarting = options.dataDir !== undefined
  const dataDir = options.dataDir ?? mkdtempSync(join(tempRoot, `solus-lab-${options.flavor}-`))
  assertTemporary(dataDir)
  if (restarting && !existsSync(join(dataDir, 'server.lock')) && !existsSync(join(dataDir, 'solus.db'))) {
    throw new Error(`The Lab refuses to restart on a data directory no host used: ${dataDir}`)
  }
  const proxiedPort = restarting ? restartProxiedPort(dataDir) : await freePort()
  const hostId = options.hostId ?? HOST_ID
  const linkSource = options.managedLink ?? (options.flavor === 'managed' && options.issuer.issueManagedLink ? 'env' : 'record')
  const managedMode = options.flavor === 'managed' && linkSource === 'env'
  const linkFile = join(dataDir, 'uplink-link.json')
  let managedLink: EnrollHostResponse | null = null
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SOLUS_DATA_DIR: dataDir,
    SOLUS_PORT: '0',
    SOLUS_NO_LAN_DISCOVERY: '1',
  }
  if (restarting) {
    // The record, tokens, and connector shim are already on the directory; the
    // previous process's lock file must go so the wait below sees the new one.
    rmSync(join(dataDir, 'server.lock'), { force: true })
    if (options.runnerOf && options.issuer.attachHostToOrganization) {
      options.issuer.attachHostToOrganization(hostId, options.runnerOf)
    }
  } else if (managedMode) {
    // No record: the host boots as a Fly machine does, in managed mode with the
    // provisioner's link in its environment, and stores it (§2). The proxied port is
    // pinned so the link names the port the host bound.
    if (!options.issuer.issueManagedLink) throw new Error('A managed host in managed mode needs an issuer that issues links')
    managedLink = options.issuer.issueManagedLink(hostId, proxiedPort)
    env.SOLUS_MANAGED = '1'
    env[MANAGED_LINK_ENV] = JSON.stringify(managedLink)
    env.SOLUS_TUNNEL_PORT = String(proxiedPort)
    writeConnectorShim(dataDir)
  } else if (options.runnerOf) {
    // A linked host with its credentials, shared with an organization: the record
    // and the tokens the real cloud's enrollment would have left, so the host's
    // generation check passes and its runner delivery can mint a grant.
    if (options.flavor !== 'personal') throw new Error('A runner is a personal host')
    if (!options.issuer.issueManagedLink || !options.issuer.attachHostToOrganization) throw new Error('A runner needs the Lab issuer')
    const enrolled = options.issuer.issueManagedLink(hostId, proxiedPort)
    options.issuer.attachHostToOrganization(hostId, options.runnerOf)
    writeFileSync(linkFile, JSON.stringify({ version: 1, desired: 'linked', link: enrolled.link }, null, 2), { mode: 0o600 })
    // The standalone server keeps secrets in files under the data directory.
    const secrets = join(dataDir, 'secrets')
    mkdirSync(secrets, { recursive: true, mode: 0o700 })
    writeFileSync(join(secrets, 'uplink-tokens.json'), JSON.stringify({ connectorToken: enrolled.connectorToken, hostToken: enrolled.hostToken }), { mode: 0o600 })
    writeConnectorShim(dataDir)
  } else {
    // The link record the real cloud would have written at enrolment. No tokens: the
    // host reports "credentials missing" for its connector and keeps verifying grants.
    writeFileSync(linkFile, JSON.stringify({
      version: 1,
      desired: 'linked',
      link: {
        hostId,
        issuer: options.issuer.issuer,
        jwksUrl: options.issuer.jwksUrl,
        directoryUrl: options.issuer.issuer,
        hostname: `h-${hostId}.lab.invalid`,
        proxiedPort,
        connectionGeneration: 1,
      },
    }, null, 2), { mode: 0o600 })
  }
  const logDir = join(dataDir, 'lab')
  mkdirSync(logDir, { recursive: true })
  const logPath = join(logDir, 'host.log')
  const output = openSync(logPath, 'w')
  // The host writes `<cwd>/dev.log` in development and truncates it on boot: its
  // working directory is the temp data directory, never the worktree.
  const child: ChildProcess = spawn(process.execPath.endsWith('bun') ? 'node' : process.execPath, [entry, '--data-dir', dataDir], {
    cwd: dataDir,
    env,
    stdio: ['ignore', output, output],
  })
  const pid = child.pid
  if (!pid) throw new Error('The Lab host did not start')
  let exited = false
  child.once('exit', () => { exited = true })

  const lockFile = join(dataDir, 'server.lock')
  await waitFor(async () => existsSync(lockFile), 30_000, 'the host lock file')
  const lock = lockFileSchema.parse(JSON.parse(readFileSync(lockFile, 'utf8')))
  const localUrl = `http://127.0.0.1:${lock.port}`
  const tunnelUrl = `http://127.0.0.1:${proxiedPort}`
  await waitFor(async () => {
    try { return (await fetch(`${localUrl}/health`)).ok } catch { return false }
  }, 30_000, 'the host to answer /health')
  await waitFor(async () => {
    try { return (await fetch(`${tunnelUrl}/health`)).ok } catch { return false }
  }, 30_000, 'the proxied listener to answer /health')
  if (managedMode) {
    // The link record is the host's own proof that it stored the environment link.
    await waitFor(async () => existsSync(linkFile), 30_000, 'the managed host to store its link')
  }

  return {
    hostId,
    flavor: options.flavor,
    dataDir,
    tunnelUrl,
    localUrl,
    pid,
    logPath,
    managedLink,
    managedMode,
    stop: async (stopOptions) => {
      if (exited) return
      // Only the PID this Lab started, never a name match.
      if (stopOptions?.kill) {
        child.kill('SIGKILL')
        await new Promise<void>((r) => child.once('exit', () => r()))
        return
      }
      child.kill('SIGTERM')
      await Promise.race([
        new Promise<void>((r) => child.once('exit', () => r())),
        new Promise<void>((r) => setTimeout(r, 10_000)),
      ])
      if (!exited) child.kill('SIGKILL')
    },
  }
}
