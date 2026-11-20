import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from '../helpers/bun-sqlite'
import { resetTestDatabase } from '../helpers/test-db'
import { TEST_HANDLER_CTX } from '../helpers/handler-ctx'
import { installTestIdentities } from '../helpers/acting-identities'
import { memoryClients, memorySecretStore } from './memory-secrets'
import type { Integration, IntegrationAuth, IntegrationChangedEvent, IntegrationLaunch } from '@solus/contracts/integration-types'
import type { Principal } from '@solus/server/admission/principal'
import type { AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import type { GatewayClock } from '@solus/server/integrations/stdio-process'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const { IntegrationGateway } = await import('@solus/server/integrations/gateway')
const { IntegrationStore } = await import('@solus/server/integrations/integration-store')
const { ServerFactsStore } = await import('@solus/server/integrations/server-facts-store')
const { IntegrationConnections } = await import('@solus/server/integrations/connections')
const { IntegrationConnectionStore } = await import('@solus/server/integrations/connection-store')
const { integrationToolbox, setIntegrationGateway } = await import('@solus/server/integrations/integration-tools')
const { stdioServerAddress } = await import('@solus/server/integrations/stdio-process')
const { registerIntegrationHandlers } = await import('@solus/server/transport/handlers/integration-handlers')
const { SolusServer } = await import('@solus/server/transport/server')
const { Vault } = await import('@solus/server/vault/vault')
const { withActingScope } = await import('@solus/server/vault/acting-scope')
const { HOST_IDENTITY } = await import('@solus/server/execution/seats/acting-identity')
const { actorFor, ownerKeyOf } = await import('@solus/server/admission/actor')
const { resolveProjectKey } = await import('@solus/server/project-config/project-config')
const { splitCommandLine } = await import('@solus/contracts/integrations/command-line')
const { agentProfileEntrySchema } = await import('@solus/contracts/agent-profile')
const { flushLogs, logFilePath } = await import('@solus/server/logger')
const { getDb, closeDb } = await import('@solus/server/db')

/**
 * Stdio MCP servers on the host (docs/plans/mcp-first-class.md §7), against a
 * fake server script this test owns, in both revisions. Each script appends
 * its PID to a file at each start, so a test counts starts and names the
 * exact process that must stop.
 */

const FIXTURE = join(import.meta.dir, '../../fixtures/fake-stdio-mcp-server.mjs')
const OWNER = ownerKeyOf(TEST_HANDLER_CTX.actor)!
const OWNER_SCOPE = { identity: HOST_IDENTITY, personKey: OWNER }
const OTHER = 'local:other-admin'
/** The local owner holds `host.admin`: a run, an app, or Settings of theirs may start a command. */
const ADMIN: Principal = TEST_HANDLER_CTX.principal
const SECRET = 's3cret-value-7f1c'

/** Idle timers that fire only when the test moves the time on. */
class FakeClock implements GatewayClock {
  time = 1_000_000
  private readonly timers = new Map<ReturnType<typeof setTimeout>, { at: number; callback: () => void }>()

  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
    // A real handle that never fires stands in as the key: the gateway calls `unref` on it.
    const handle = setTimeout(() => undefined, 0)
    clearTimeout(handle)
    this.timers.set(handle, { at: this.time + ms, callback })
    return handle
  }

  clearTimeout(timer: ReturnType<typeof setTimeout>): void {
    this.timers.delete(timer)
  }

  now(): number {
    return this.time
  }

  advance(ms: number): void {
    this.time += ms
    for (const [handle, timer] of [...this.timers].sort(([, a], [, b]) => a.at - b.at)) {
      if (timer.at > this.time) continue
      this.timers.delete(handle)
      timer.callback()
    }
  }
}

let workDir: string
const gateways: InstanceType<typeof IntegrationGateway>[] = []
/** Every start file a test made, so no process of a test outlives it. */
const startFiles: string[] = []

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'solus-stdio-'))
})

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()))
  setIntegrationGateway(null)
  // Each PID here is one this test's gateway started: none may be left running.
  const left = startFiles.splice(0).flatMap(startsOf).filter(isAlive)
  for (const pid of left) process.kill(pid, 'SIGKILL')
  expect(left).toEqual([])
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(process.env.SOLUS_DATA_DIR!, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  closeDb()
  rmSync(workDir, { recursive: true, force: true })
})

function startsOf(file: string): number[] {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number) : []
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function context(): AgentToolContext {
  return { provider: 'claude-code', cwd: workDir, sessionId: () => 'session-1', abortSignal: new AbortController().signal, parentToolUseId: () => undefined, emit: () => undefined }
}

const store = new IntegrationStore()

/** A `stdio` record of `owner` for the fake server, with its own start file. */
function command(options: { era?: 'modern' | 'legacy'; owner?: string; auth?: IntegrationAuth; cwd?: string; extra?: string[]; projectKey?: string; organizationId?: string } = {}): { integration: Integration; starts: string } {
  const starts = join(workDir, `starts-${crypto.randomUUID()}`)
  startFiles.push(starts)
  const launch: IntegrationLaunch = { command: process.execPath, args: [FIXTURE, '--era', options.era ?? 'modern', '--starts', starts, ...(options.extra ?? [])] }
  if (options.cwd) launch.cwd = options.cwd
  const integration = store.create({ name: 'Fake', url: stdioServerAddress(launch), slug: 'fake', auth: options.auth ?? { kind: 'none' }, launch, projectKey: options.projectKey }, options.organizationId ?? 'local', options.owner ?? OWNER)
  return { integration, starts }
}

function gateway(options: { clock?: FakeClock; values?: Map<string, string> } = {}) {
  const created = new IntegrationGateway(store, undefined, { clock: options.clock, savedFacts: new ServerFactsStore() })
  created.useCredentials({
    authorizationFor: async () => null,
    markNeedsSignIn: () => undefined,
    environmentFor: () => (options.values ? [...options.values].map(([name, value]) => ({ name, value })) : null),
  })
  gateways.push(created)
  return created
}

const asOwner = <T>(work: () => Promise<T>) => withActingScope(OWNER_SCOPE, work)

describe('the verdict and the saved facts (§7.5)', () => {
  for (const era of ['modern', 'legacy'] as const) {
    test(`a ${era} server: the first start checks the revision, and with the saved verdict the command starts once`, async () => {
      // WHY: in `auto` mode the SDK starts a stdio command twice; a saved verdict must make every later start one process.
      const { integration, starts } = command({ era })
      const first = gateway()
      const facts = await asOwner(() => first.startProcess(integration.id, ADMIN))
      expect(facts.era).toBe(era)
      expect(facts.instructions).toBe(`Use the ${era} fake for tests.`)
      expect(facts.process?.state).toBe('running')
      expect(startsOf(starts)).toHaveLength(2)
      await first.close()

      const second = gateway()
      const result = await asOwner(() => second.call(integration.id, 'echo', { text: 'hi' }, context(), ADMIN))
      expect(result).toEqual({ ok: true, text: 'echo: hi' })
      expect(startsOf(starts)).toHaveLength(3)
    })
  }

  test('a run start with saved facts gets the tools and starts no process', async () => {
    // WHY: a run lists every integration's tools; starting each command for that would start code nobody used.
    const { integration, starts } = command()
    await asOwner(() => gateway().startProcess(integration.id, ADMIN))
    await Promise.all(gateways.splice(0).map((each) => each.close()))
    const before = startsOf(starts).length

    const fresh = gateway()
    setIntegrationGateway(fresh)
    const { tools, instructions } = await integrationToolbox(TEST_HANDLER_CTX.actor)
    expect(tools.map((tool) => tool.name)).toEqual(['fake__echo', 'fake__env', 'fake__cwd', 'fake__crash'])
    expect(instructions).toEqual([{ name: 'Fake', slug: 'fake', text: 'Use the modern fake for tests.' }])
    expect(startsOf(starts)).toHaveLength(before)
    expect((await asOwner(() => fresh.facts(integration.id))).process).toEqual({ state: 'stopped' })
  })

  test('without saved facts a run gets no tools of a command and starts nothing', async () => {
    const { starts } = command()
    setIntegrationGateway(gateway())
    expect((await integrationToolbox(TEST_HANDLER_CTX.actor)).tools).toEqual([])
    expect(startsOf(starts)).toEqual([])
  })

  test('a project command joins only the runs of its project', async () => {
    // WHY: a command from one repository must not reach the agent in another project (§8.4).
    const projectA = mkdtempSync(join(workDir, 'a-'))
    const projectB = mkdtempSync(join(workDir, 'b-'))
    const { integration } = command({ projectKey: resolveProjectKey(projectA) })
    const started = gateway()
    await asOwner(() => started.startProcess(integration.id, ADMIN))
    setIntegrationGateway(started)
    expect((await integrationToolbox(TEST_HANDLER_CTX.actor, projectA)).tools).toHaveLength(4)
    expect((await integrationToolbox(TEST_HANDLER_CTX.actor, projectB)).tools).toEqual([])
    expect((await integrationToolbox(TEST_HANDLER_CTX.actor)).tools).toEqual([])
  })
})

describe('the process (§7.3)', () => {
  test('an idle close stops exactly that process', async () => {
    // WHY: Solus must stop the child it started, never another process, and only after the idle time.
    const clock = new FakeClock()
    const a = command()
    const b = command()
    const shared = gateway({ clock })
    await asOwner(() => shared.call(a.integration.id, 'echo', { text: 'a' }, context(), ADMIN))
    await asOwner(() => shared.call(b.integration.id, 'echo', { text: 'b' }, context(), ADMIN))
    const [pidA] = startsOf(a.starts).slice(-1)
    const [pidB] = startsOf(b.starts).slice(-1)

    clock.advance(5 * 60_000)
    await asOwner(() => shared.call(b.integration.id, 'echo', { text: 'b again' }, context(), ADMIN))
    expect(isAlive(pidA)).toBe(true)

    const stopped = new Promise<void>((resolve) => shared.onFactsChanged((id) => { if (id === a.integration.id) resolve() }))
    clock.advance(5 * 60_000 + 1)
    await stopped
    expect(isAlive(pidA)).toBe(false)
    expect(isAlive(pidB)).toBe(true)
    expect((await asOwner(() => shared.facts(a.integration.id))).process).toEqual({ state: 'stopped' })
    expect((await asOwner(() => shared.facts(b.integration.id))).process).toEqual({ state: 'running' })
  })

  test('a crash fails the call in flight with the defined text, and the next call starts it again', async () => {
    const { integration, starts } = command()
    const shared = gateway()
    await asOwner(() => shared.startProcess(integration.id, ADMIN))
    const crashed = await asOwner(() => shared.call(integration.id, 'crash', {}, context(), ADMIN))
    expect(crashed).toEqual({ ok: false, text: 'Fake stopped while it ran crash.' })
    expect((await asOwner(() => shared.facts(integration.id))).process).toEqual({ state: 'stopped', message: 'Fake stopped by itself.' })

    const before = startsOf(starts).length
    expect(await asOwner(() => shared.call(integration.id, 'echo', { text: 'back' }, context(), ADMIN))).toEqual({ ok: true, text: 'echo: back' })
    expect(startsOf(starts)).toHaveLength(before + 1)
  })

  test('three ends soon after a start give failed, and only Start again starts it', async () => {
    // WHY: a command that crashes at once must not start again on every tool call.
    const clock = new FakeClock()
    const { integration, starts } = command()
    const shared = gateway({ clock })
    for (let end = 0; end < 3; end++) await asOwner(() => shared.call(integration.id, 'crash', {}, context(), ADMIN))
    const facts = await asOwner(() => shared.facts(integration.id))
    expect(facts.process?.state).toBe('failed')
    expect(facts.process?.message).toContain('Start again')

    const before = startsOf(starts).length
    const refused = await asOwner(() => shared.call(integration.id, 'echo', { text: 'x' }, context(), ADMIN))
    expect(refused.ok).toBe(false)
    expect(refused.text).toContain('Start again')
    expect(startsOf(starts)).toHaveLength(before)

    expect((await asOwner(() => shared.startProcess(integration.id, ADMIN))).process).toEqual({ state: 'running' })
  })

  test('a command that is not installed is failed with the reason', async () => {
    const launch: IntegrationLaunch = { command: 'solus-no-such-mcp-command', args: [] }
    const integration = store.create({ name: 'Missing', url: stdioServerAddress(launch), slug: 'missing', auth: { kind: 'none' }, launch }, 'local', OWNER)
    const shared = gateway()
    await expect(asOwner(() => shared.startProcess(integration.id, ADMIN))).rejects.toThrow('`solus-no-such-mcp-command` is not installed on this host')
    const process = (await asOwner(() => shared.facts(integration.id))).process
    expect(process?.state).toBe('failed')
    // Settings words it "Not installed", not a crash: a retry helps only once the program is there.
    expect(process?.startFailure).toBe('not-installed')
  })

  test('`~` as the working directory is the home folder', async () => {
    const { integration } = command({ cwd: '~' })
    expect(await asOwner(() => gateway().call(integration.id, 'cwd', {}, context(), ADMIN))).toEqual({ ok: true, text: homedir() })
  })

  test('two people get two processes, and the host\'s own work starts none', async () => {
    const mine = command()
    const theirs = command({ owner: OTHER })
    const shared = gateway()
    await asOwner(() => shared.call(mine.integration.id, 'echo', { text: '1' }, context(), ADMIN))
    await withActingScope({ identity: HOST_IDENTITY, personKey: OTHER }, () => shared.call(theirs.integration.id, 'echo', { text: '2' }, context(), ADMIN))
    expect(startsOf(mine.starts).at(-1)).not.toBe(startsOf(theirs.starts).at(-1))
    // Another person cannot start my command through a call.
    const refused = await withActingScope({ identity: HOST_IDENTITY, personKey: OTHER }, () => shared.call(mine.integration.id, 'echo', { text: '3' }, context(), ADMIN))
    expect(refused.text).toContain('runs only for the person who added it')
  })
})

describe('the environment (§7.1, §7.9)', () => {
  test('a value reaches the child, no variable of the server does, and no value is in a record or a log', async () => {
    // WHY: every environment value is a secret; it goes into that server's process and nowhere else.
    process.env.SOLUS_B1_SERVER_ONLY = 'server-only-value'
    try {
      const { integration } = command({ auth: { kind: 'env', names: ['API_TOKEN'] }, extra: ['--stderr-env', 'API_TOKEN'] })
      const vault = new Vault({ secrets: memorySecretStore() })
      const connections = new IntegrationConnections({
        store: new IntegrationConnectionStore(), integrations: store, vault, clients: memoryClients(), oauth: {} as never,
        events: { connectionChanged: () => undefined, authFinished: () => undefined },
      })
      expect(() => connections.submitEnvironment(integration, OWNER, [{ name: 'OTHER', value: 'x' }])).toThrow('Give a value for API_TOKEN.')
      connections.submitEnvironment(integration, OWNER, [{ name: 'API_TOKEN', value: SECRET }])
      const shared = new IntegrationGateway(store, undefined, { savedFacts: new ServerFactsStore() })
      shared.useCredentials(connections)
      gateways.push(shared)

      expect(await asOwner(() => shared.call(integration.id, 'env', { name: 'API_TOKEN' }, context(), ADMIN))).toEqual({ ok: true, text: SECRET })
      expect(await asOwner(() => shared.call(integration.id, 'env', { name: 'SOLUS_B1_SERVER_ONLY' }, context(), ADMIN))).toEqual({ ok: true, text: '(unset)' })
      await asOwner(() => shared.startProcess(integration.id, ADMIN))
      await asOwner(() => shared.call(integration.id, 'crash', {}, context(), ADMIN))
      // The owner sees what the server printed; nothing else holds it.
      expect((await asOwner(() => shared.facts(integration.id))).process?.stderrTail).toContain(SECRET)

      const rows = JSON.stringify([
        getDb().prepare('SELECT * FROM integration').all(),
        getDb().prepare('SELECT * FROM integration_server_facts').all(),
        getDb().prepare('SELECT * FROM integration_connection').all(),
      ])
      expect(rows).toContain('API_TOKEN')
      expect(rows).not.toContain(SECRET)
      expect(JSON.stringify(store.get(integration.id, 'local'))).not.toContain(SECRET)
      flushLogs()
      expect(readFileSync(logFilePath(), 'utf8')).not.toContain(SECRET)

      // Disconnect takes the values back: the next start has none to give.
      await connections.disconnect(integration, OWNER)
      expect(connections.environmentFor(integration.id, OWNER)).toBeNull()
    } finally {
      delete process.env.SOLUS_B1_SERVER_ONLY
    }
  })
})

describe('who may add a command (§7.2)', () => {
  const member: Principal = { kind: 'org-member', userId: 'member-1', organizationId: 'org1', organizationRole: 'member', teamIds: [], hostKind: 'personal', displayName: 'Member', deviceId: 'member-device', deviceLabel: 'Browser', expiresAt: Date.now() + 300_000 }

  function handlers() {
    installTestIdentities()
    const server = new SolusServer()
    const changed: IntegrationChangedEvent[] = []
    registerIntegrationHandlers(server, {
      store,
      catalog: {} as never,
      gateway: { invalidate: () => undefined, forget: () => undefined } as never,
      events: { broadcast: (_topic: string, event: IntegrationChangedEvent) => { changed.push(event); return 1 } } as never,
      connectionStore: {} as never,
      connections: {} as never,
      oauth: {} as never,
      clients: memoryClients(),
      getServerInfo: () => ({ host: '127.0.0.1', port: 4100 }),
    })
    return { server, changed }
  }

  test('a person without host.admin is refused; an administrator adds the command without starting it', async () => {
    // WHY: a command runs as code on the host, as the OS user of the Solus server.
    const { server, changed } = handlers()
    const request = { name: 'Files', commandLine: 'npx -y @modelcontextprotocol/server-filesystem "/data dir"', envNames: ['TOKEN'] }
    await expect(server.handle('integrationCreate', [request], { clientId: 'member', principal: member })).rejects.toThrow('Only an administrator of this host can add or change a command.')
    expect(changed).toEqual([])

    const created = await server.handle('integrationCreate', [request], TEST_HANDLER_CTX)
    expect(created.kind).toBe('stdio')
    expect(created.launch).toEqual({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/data dir'] })
    expect(created.auth).toEqual({ kind: 'env', names: ['TOKEN'] })
    expect(created.url).toBe(stdioServerAddress({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/data dir'] }))
    expect(changed).toEqual([{ integrationId: created.id, change: 'created' }])
    expect(await server.handle('integrationConnectStart', [{ id: created.id }], TEST_HANDLER_CTX)).toEqual({ kind: 'env', integrationId: created.id, accountId: 'default', names: ['TOKEN'] })
  })

  test('a shell operator in the line is refused with the reason', async () => {
    const { server } = handlers()
    await expect(server.handle('integrationCreate', [{ name: 'Piped', commandLine: 'npx server | tee log', envNames: [] }], TEST_HANDLER_CTX)).rejects.toThrow('a pipe (|)')
  })
})

describe('new environment names (§7.6)', () => {
  test('every person who gave values gets a connection change with no connection, and the values are gone', async () => {
    // WHY: an open Settings page must not show a person as connected with values the host no longer has.
    installTestIdentities()
    const { integration } = command({ auth: { kind: 'env', names: ['API_TOKEN'] } })
    const changes: Array<{ personKey: string; integrationId: string; accountId?: string; connection: unknown }> = []
    const connections = new IntegrationConnections({
      store: new IntegrationConnectionStore(), integrations: store, vault: new Vault({ secrets: memorySecretStore() }), clients: memoryClients(), oauth: {} as never,
      events: { connectionChanged: (personKey, event) => changes.push({ personKey, ...event }), authFinished: () => undefined },
    })
    connections.submitEnvironment(integration, OWNER, [{ name: 'API_TOKEN', value: SECRET }])
    changes.length = 0
    const server = new SolusServer()
    registerIntegrationHandlers(server, {
      store,
      catalog: {} as never,
      gateway: gateway(),
      events: { broadcast: () => 1 } as never,
      connectionStore: {} as never,
      connections,
      oauth: {} as never,
      clients: memoryClients(),
      getServerInfo: () => ({ host: '127.0.0.1', port: 4100 }),
    })

    await server.handle('integrationUpdate', [{ id: integration.id, envNames: ['API_KEY'] }], TEST_HANDLER_CTX)
    expect(changes).toEqual([{ personKey: OWNER, integrationId: integration.id, accountId: 'default', connection: null }])
    expect(connections.environmentFor(integration.id, OWNER)).toBeNull()
  })
})

describe('who may start a command (§7.2, §7.8)', () => {
  // The owner's own record, but a principal without `host.admin`: only the admin rule refuses it.
  const member: Principal = { kind: 'org-member', userId: 'member-1', organizationId: 'org1', organizationRole: 'member', teamIds: [], hostKind: 'personal', displayName: 'Member', deviceId: 'member-device', deviceLabel: 'Browser', expiresAt: Date.now() + 300_000 }
  const refusal = 'Only an administrator of this host can start a command.'

  test('a run, an MCP App, an app of Solus, and Settings all refuse a start without host.admin, and start for an administrator', async () => {
    // WHY: a command runs as code on the host. Before, an MCP App call started it with the owner check alone.
    const { integration, starts } = command()
    const shared = gateway()
    const run = await asOwner(() => shared.call(integration.id, 'echo', { text: 'run' }, context(), member))
    expect(run.ok).toBe(false)
    expect(run.text).toContain(refusal)
    await expect(asOwner(() => shared.callAppTool(integration.id, 'echo', { text: 'app' }, member))).rejects.toThrow(refusal)
    await expect(asOwner(() => shared.readAppResource(integration.id, 'ui://fake/app', member))).rejects.toThrow(refusal)
    await expect(asOwner(() => shared.startProcess(integration.id, member))).rejects.toThrow(refusal)
    // The host's own work, such as an app's schedule, names no person: it starts nothing either.
    await expect(asOwner(() => shared.callAppTool(integration.id, 'echo', { text: 'schedule' }, null))).rejects.toThrow('acts for no person who can start it')
    expect(startsOf(starts)).toEqual([])

    const answered = await asOwner(() => shared.callAppTool(integration.id, 'echo', { text: 'app' }, ADMIN))
    expect(answered.content).toEqual([{ type: 'text', text: 'echo: app' }])
    expect(startsOf(starts).length).toBeGreaterThan(0)
  })

  test('integrationProcessStart refuses the owner of the record without host.admin, and starts it once they hold it', async () => {
    installTestIdentities()
    // The member's own record, in their organization: only the admin rule can refuse them.
    const memberKey = ownerKeyOf(actorFor(member))!
    const { integration, starts } = command({ organizationId: 'org1', owner: memberKey })
    const server = new SolusServer()
    registerIntegrationHandlers(server, {
      store,
      catalog: {} as never,
      gateway: gateway(),
      events: { broadcast: () => 1 } as never,
      connectionStore: {} as never,
      connections: {} as never,
      oauth: {} as never,
      clients: memoryClients(),
      getServerInfo: () => ({ host: '127.0.0.1', port: 4100 }),
    })
    await expect(server.handle('integrationProcessStart', [{ id: integration.id }], { clientId: 'member', principal: member })).rejects.toThrow(refusal)
    expect(startsOf(starts)).toEqual([])
    // The same person as the owner of a managed host's organization holds host.admin.
    const administrator: Principal = { ...member, organizationRole: 'owner', hostKind: 'managed' }
    expect((await server.handle('integrationProcessStart', [{ id: integration.id }], { clientId: 'member', principal: administrator })).process).toEqual({ state: 'running' })
  })
})

describe('the command line (§7.4)', () => {
  test('quotes are kept; an operator or an expansion is refused', () => {
    expect(splitCommandLine(`uvx mcp-server --root '/a b' --name "x\\"y" c\\ d`)).toEqual({ ok: true, launch: { command: 'uvx', args: ['mcp-server', '--root', '/a b', '--name', 'x"y', 'c d'] } })
    expect(splitCommandLine(`node server.js '$HOME|;'`)).toEqual({ ok: true, launch: { command: 'node', args: ['server.js', '$HOME|;'] } })
    for (const line of ['a && b', 'a; b', 'a > out', 'a < in', 'a `b`', 'a $(b)', 'a "$HOME"', 'a ${X}']) {
      expect(splitCommandLine(line).ok).toBe(false)
    }
    expect(splitCommandLine('a "open')).toEqual({ ok: false, reason: 'The command has a double quote that is not closed.' })
    expect(splitCommandLine('   ').ok).toBe(false)
  })

  test('a command is not an agent profile entry', () => {
    // WHY: a stdio integration belongs to the host it was added on (§7.8), so no profile can carry one.
    expect(agentProfileEntrySchema.safeParse({ kind: 'integration', slug: 'files', name: 'Files', url: 'stdio:0123456789abcdef', auth: { kind: 'env', names: ['TOKEN'] } }).success).toBe(false)
  })
})
