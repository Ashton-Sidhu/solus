import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { HOST_LINK_ENV, hostPublicJwkSchema, type HostKind, type HostLinkEnv } from '@solus/contracts/uplink'
import { ORGANIZATION_ID } from './personas'
import { LAB_BUILD_ENTRY } from './build'
import type { LabIssuer } from './issuer'

/**
 * An isolated headless Solus host for the Lab (plan §8.1, §8.8). It boots the built
 * standalone server on a temporary data directory, linked to the Lab issuer by a
 * hand-written link record, so its proxied listener admits only grants and its
 * verifier trusts only the Lab's key. It never sees `~/.solus`.
 */

export interface LabHostOptions {
  flavor: HostKind
  /**
   * The Lab's own issuer, or a real control plane the host should trust instead. Absent
   * with `unregistered`: a real Solus cloud registers the host later (cloud mode).
   */
  issuer?: Pick<LabIssuer, 'issuer' | 'jwksUrl'> & Partial<Pick<LabIssuer, 'issueManagedLink' | 'issueEnrolledLink' | 'attachHostToOrganization'>>
  /** The host id the link names; defaults to the Lab's fixed id. A real cloud names its own. */
  hostId?: string
  /** Path to the standalone server; defaults to `SOLUS_LAB_ENTRY`, then the Lab build (`bun lab build`). */
  entry?: string
  /** Where the temporary data directory is made; must be a temp location. */
  tempRoot?: string
  /**
   * How a managed host gets its link (docs/plans/managed-hosts.md §1–§2). `env` boots
   * the server with no link record and the issuer's provisioned link in its
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
  /**
   * Boot with no registration and no link record, as a new install does (cloud mode).
   * A signed-in owner then registers it with an enrollment ticket (`uplinkRegister`).
   */
  unregistered?: boolean
  /** Start the server in its own process group and do not wait for it at exit: `bun lab up` leaves it running. */
  longLived?: boolean
  /** The proxied listener's port; a restarted host with no link record keeps the one it had. */
  tunnelPort?: number
  /** More environment for the server, e.g. the `SOLUS_HOST_LINK` a provisioner gives a managed machine. */
  environment?: NodeJS.ProcessEnv
}

export interface LabHost {
  readonly hostId: string
  readonly flavor: HostKind
  readonly dataDir: string
  /** The proxied listener: loopback on the wire, never trusted, grants only. */
  readonly tunnelUrl: string
  /** The ordinary listener: a trusted loopback caller is the local owner. */
  readonly localUrl: string
  /** A paired session token the local owner presents to the record API, minted on the host's own keys. */
  localOwnerToken(): Promise<string>
  readonly pid: number
  readonly logPath: string
  /** The link the host was started with in its environment; set only for a managed host booted from its environment link. */
  readonly managedLink: HostLinkEnv | null
  /** True when the server booted with a provisioned link in its environment (`SOLUS_HOST_LINK`), as a managed machine does. */
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

/**
 * Every host this Lab process started and has not stopped. A scenario that fails part
 * way may never stop the hosts it booted; when the Lab exits, they end with it. Only
 * these PIDs, never a name match. A long-lived host (`bun lab up`) is not here.
 */
const runningHosts = new Set<ChildProcess>()
process.once('exit', () => {
  for (const child of runningHosts) child.kill('SIGKILL')
})

/** The server's own `auth session create` on the host's data directory: a paired token its keys verify. */
function mintLocalOwnerToken(entry: string, dataDir: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolveToken, reject) => {
    execFile(process.execPath.endsWith('bun') ? 'node' : process.execPath, [entry, 'auth', 'session', 'create', '--data-dir', dataDir, '--json'], { cwd: dataDir, env }, (error, stdout) => {
      if (error) return reject(error)
      resolveToken(z.object({ sessionToken: z.string().min(1) }).parse(JSON.parse(stdout)).sessionToken)
    })
  })
}
const linkFileSchema = z.object({ tunnel: z.object({ proxiedPort: z.number().int().positive() }) })

/** A restarted host must bind the proxied port its link names, or its record would be stale. */
function restartProxiedPort(dataDir: string): number {
  const parsed = linkFileSchema.safeParse(JSON.parse(readFileSync(join(dataDir, 'host-link.json'), 'utf8')))
  if (!parsed.success) throw new Error(`The Lab cannot restart a host without a link record in ${dataDir}`)
  return parsed.data.tunnel.proxiedPort
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
  const entry = options.entry ?? process.env.SOLUS_LAB_ENTRY ?? LAB_BUILD_ENTRY
  if (!existsSync(entry)) throw new Error(`No standalone build at ${entry}; run \`bun lab build\` first.`)
  const tempRoot = options.tempRoot ?? tmpdir()
  const restarting = options.dataDir !== undefined
  const dataDir = options.dataDir ?? mkdtempSync(join(tempRoot, `solus-lab-${options.flavor}-`))
  assertTemporary(dataDir)
  if (restarting && !existsSync(join(dataDir, 'server.lock')) && !existsSync(join(dataDir, 'solus.db'))) {
    throw new Error(`The Lab refuses to restart on a data directory no host used: ${dataDir}`)
  }
  const proxiedPort = options.tunnelPort ?? (restarting ? restartProxiedPort(dataDir) : await freePort())
  const hostId = options.hostId ?? HOST_ID
  const issuer = options.issuer
  const linkSource = options.managedLink ?? (options.flavor === 'managed' && issuer?.issueManagedLink ? 'env' : 'record')
  const managedMode = options.flavor === 'managed' && linkSource === 'env'
  const registrationFile = join(dataDir, 'host-registration.json')
  const linkFile = join(dataDir, 'host-link.json')
  let managedLink: HostLinkEnv | null = null
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SOLUS_DATA_DIR: dataDir,
    SOLUS_PORT: '0',
    SOLUS_NO_LAN_DISCOVERY: '1',
    // Never the default port, which the developer's own Solus holds.
    SOLUS_TUNNEL_PORT: String(proxiedPort),
    // The host's log stays in its temporary data directory, never the worktree's dev.log.
    SOLUS_DEV_LOG: join(dataDir, 'dev.log'),
    // The owner's homes are the host login's (`~/.claude`, `~/.codex`): an agent profile
    // pull writes there. A Lab host must never write the developer's own.
    HOME: join(dataDir, 'home'),
    CODEX_HOME: join(dataDir, 'home', '.codex'),
    ...options.environment,
  }
  if (restarting) {
    // The record, tokens, and connector shim are already on the directory; the
    // previous process's lock file must go so the wait below sees the new one.
    rmSync(join(dataDir, 'server.lock'), { force: true })
    if (options.runnerOf && issuer?.attachHostToOrganization) {
      issuer.attachHostToOrganization(hostId, options.runnerOf)
    }
  } else if (options.unregistered) {
    // No record: the host is registered to no account yet. A link made later runs the
    // shim, never a real `cloudflared` on the PATH.
    writeConnectorShim(dataDir)
  } else if (managedMode) {
    // No record: the host boots as a Sprite does, with the provisioner's link in its
    // environment, and stores it (§2); the organization the link names makes it a
    // managed host. The proxied port is pinned so the link names the port the host bound.
    if (!issuer?.issueManagedLink) throw new Error('A managed host booted from its environment link needs an issuer that issues links')
    managedLink = issuer.issueManagedLink(hostId, proxiedPort, 1, ORGANIZATION_ID)
    env[HOST_LINK_ENV] = JSON.stringify(managedLink)
    writeConnectorShim(dataDir)
  } else if (options.runnerOf) {
    // A registered and linked host with its credential, shared with an organization: the
    // registration, the link, the connector token, and the key the real registration
    // would have left, so the host's check passes and it can trade a person's token for
    // a delegation.
    if (options.flavor !== 'personal') throw new Error('A runner is a personal host')
    if (!issuer?.issueEnrolledLink || !issuer.attachHostToOrganization) throw new Error('A runner needs the Lab issuer')
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const privateJwk = privateKey.export({ format: 'jwk' })
    const publicJwk = hostPublicJwkSchema.parse({ kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y })
    const enrolled = issuer.issueEnrolledLink(hostId, proxiedPort, publicJwk)
    issuer.attachHostToOrganization(hostId, options.runnerOf)
    writeFileSync(registrationFile, JSON.stringify({ version: 1, registration: enrolled.registration }, null, 2), { mode: 0o600 })
    writeFileSync(linkFile, JSON.stringify({ version: 2, hostId, desired: 'linked', tunnel: { hostname: `h-${hostId}.lab.invalid`, proxiedPort } }, null, 2), { mode: 0o600 })
    // The standalone server keeps secrets in files under the data directory.
    const secrets = join(dataDir, 'secrets')
    mkdirSync(secrets, { recursive: true, mode: 0o700 })
    // The Lab runs no tunnel; the host's connector gets a token it can never use.
    writeFileSync(join(secrets, 'uplink-tokens.json'), JSON.stringify({ connectorToken: 'lab-connector-token' }), { mode: 0o600 })
    writeFileSync(join(secrets, 'host-credential.json'), JSON.stringify({ version: 1, clientId: enrolled.oauthClient.clientId, generation: enrolled.registration.generation, privateJwk }), { mode: 0o600 })
    writeConnectorShim(dataDir)
  } else {
    // The registration and link records the real cloud would have answered. No key and
    // no connector token: the host keeps verifying grants, makes no delegation, and
    // reports its tunnel credential missing.
    if (!issuer) throw new Error('A registered Lab host needs an issuer')
    writeFileSync(linkFile, JSON.stringify({ version: 2, hostId, desired: 'linked', tunnel: { hostname: `h-${hostId}.lab.invalid`, proxiedPort } }, null, 2), { mode: 0o600 })
    writeFileSync(registrationFile, JSON.stringify({
      version: 1,
      registration: {
        hostId,
        issuer: issuer.issuer,
        jwksUrl: issuer.jwksUrl,
        directoryUrl: issuer.issuer,
        generation: 1,
      },
    }, null, 2), { mode: 0o600 })
  }
  mkdirSync(join(dataDir, 'home'), { recursive: true })
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
    detached: options.longLived ?? false,
  })
  const pid = child.pid
  if (!pid) throw new Error('The Lab host did not start')
  if (options.longLived) child.unref()
  let exited = false
  if (!options.longLived) runningHosts.add(child)
  child.once('exit', () => { exited = true; runningHosts.delete(child) })

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
    localOwnerToken: () => mintLocalOwnerToken(entry, dataDir, env),
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
