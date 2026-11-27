import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from '../helpers/bun-sqlite'
import { resetTestDatabase } from '../helpers/test-db'
import { TEST_HANDLER_CTX } from '../helpers/handler-ctx'
import type { FoundServer, Integration, IntegrationEnvValue } from '@solus/contracts/integration-types'
import { startFakeServers, type FakeServers } from './fake-servers'
import type { Principal } from '@solus/server/admission/principal'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const { FoundServers } = await import('@solus/server/integrations/found-servers')
const { IntegrationWrites } = await import('@solus/server/integrations/integration-create')
const { IntegrationStore } = await import('@solus/server/integrations/integration-store')
const { stdioServerAddress } = await import('@solus/server/integrations/stdio-process')
const { ownerKeyOf } = await import('@solus/server/admission/actor')
const { recordScopeOf } = await import('@solus/server/admission/principal')
const { resolveProjectKey } = await import('@solus/server/project-config/project-config')
const { closeDb } = await import('@solus/server/db')
const { cliSkipLog } = await import('@solus/server/integrations/cli-skips')
const { ConfigWrites } = await import('@solus/server/integrations/found/config-writes')

/**
 * Found servers (docs/plans/mcp-first-class.md §8): the host reads the config
 * files of other tools, in a home folder and a project this test owns, and
 * adds nothing until the person adds it.
 */

const OWNER = ownerKeyOf(TEST_HANDLER_CTX.actor)!
/** The local owner holds `host.admin`. */
const ADMIN: Principal = TEST_HANDLER_CTX.principal
const MEMBER: Principal = { kind: 'org-member', userId: 'member-1', organizationId: 'org1', organizationRole: 'member', teamIds: [], hostKind: 'personal', displayName: 'Member', deviceId: 'member-device', deviceLabel: 'Browser', expiresAt: Date.now() + 300_000 }
const SECRET = 's3cret-value-7f1c'
const NODE = process.execPath

const store = new IntegrationStore()
let root: string
let home: string
let project: string
let submitted: Array<{ integrationId: string; values: IntegrationEnvValue[] }>
let codexLayers: unknown[]
let profileSaves: string[]
let ownerClients: Array<{ clientId: string }>
let fake: FakeServers

beforeAll(async () => {
  fake = await startFakeServers()
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'solus-found-'))
  home = join(root, 'home')
  project = join(root, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  submitted = []
  codexLayers = []
  profileSaves = []
  ownerClients = []
})

afterEach(async () => {
  rmSync(root, { recursive: true, force: true })
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(process.env.SOLUS_DATA_DIR!, `solus.db${suffix}`), { force: true })
})

afterAll(async () => {
  closeDb()
  await fake.close()
})

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}

function found(configWrites?: InstanceType<typeof ConfigWrites>) {
  return new FoundServers({
    configWrites,
    store,
    writes: new IntegrationWrites({
      store,
      events: { broadcast: () => 1 } as never,
      profile: { saved: async (_principal, integration: Integration) => { profileSaves.push(integration.name) } },
      gateway: { forget: () => undefined, invalidate: () => undefined },
      connections: { removeAllFor: () => undefined },
      oauth: {
        withOwnerClient: async (integration: Integration, client: { clientId: string }) => {
          ownerClients.push(client)
          return { ...integration.auth, clientId: client.clientId }
        },
      } as never,
    }),
    connections: {
      submitEnvironment: (integration, _person, values) => {
        submitted.push({ integrationId: integration.id, values })
        return {} as never
      },
      environmentFor: (integrationId) => submitted.find((entry) => entry.integrationId === integrationId)?.values ?? null,
      submitKey: async () => ({}) as never,
    },
    codexLayers: async () => codexLayers,
    home,
    env: { NODE_ENV: 'test' },
    platform: 'linux',
  })
}

function byName(servers: FoundServer[], name: string): FoundServer {
  const server = servers.find((each) => each.name === name)
  if (!server) throw new Error(`no found server ${name}`)
  return server
}

describe('reading the files (§8.1)', () => {
  test('each file kind gives its servers, with the file it is in', async () => {
    write(join(project, '.mcp.json'), { mcpServers: { repo: { command: NODE, args: ['repo.js'] } } })
    write(join(project, '.cursor', 'mcp.json'), { mcpServers: { cursorProject: { command: NODE, args: ['cursor-project.js'] } } })
    write(join(project, '.vscode', 'mcp.json'), { servers: { vscodeProject: { type: 'stdio', command: NODE, args: ['vscode.js'] } } })
    write(join(home, '.claude.json'), { mcpServers: { claudeUser: { type: 'http', url: 'https://claude-user.example/mcp' } }, projects: { [project]: { mcpServers: { claudeLocal: { command: NODE, args: ['local.js'] } } } } })
    write(join(home, '.cursor', 'mcp.json'), { mcpServers: { cursorUser: { url: 'https://cursor.example/mcp' } } })
    write(join(home, '.config', 'Code', 'User', 'mcp.json'), { servers: { vscodeUser: { type: 'http', url: 'https://vscode.example/mcp' } } })
    write(join(home, '.config', 'Claude', 'claude_desktop_config.json'), { mcpServers: { desktop: { command: NODE, args: ['desktop.js'] } } })
    // Google Antigravity's own file; agy still reads `serverUrl`, its older name for `url`.
    write(join(home, '.gemini', 'config', 'mcp_config.json'), { mcpServers: { agyRemote: { serverUrl: 'https://agy.example/mcp' }, agyLocal: { command: NODE, args: ['agy.js'] } } })
    codexLayers = [{ name: { type: 'user', file: join(home, '.codex', 'config.toml'), profile: null }, config: { mcp_servers: { codexUser: { url: 'https://codex.example/mcp' } } }, disabledReason: null }]

    const list = await found().list(ADMIN, OWNER, { projectPath: project })
    const files = Object.fromEntries(list.servers.map((server) => [server.name, server.foundIn.map((place) => `${place.file}:${place.scope}`)]))
    expect(files).toEqual({
      agyLocal: ['antigravity-config:user'],
      agyRemote: ['antigravity-config:user'],
      claudeLocal: ['claude-json:project'],
      claudeUser: ['claude-json:user'],
      codexUser: ['codex-config:user'],
      cursorProject: ['cursor:project'],
      cursorUser: ['cursor:user'],
      desktop: ['claude-desktop:user'],
      repo: ['mcp-json:project'],
      vscodeProject: ['vscode:project'],
      vscodeUser: ['vscode:user'],
    })
    expect(byName(list.servers, 'claudeLocal').projectOnly).toBe(true)
    expect(list.servers.every((server) => server.state === 'new')).toBe(true)
    // A path as the person reads it, with `~` for the host's home folder.
    expect(byName(list.servers, 'desktop').foundIn[0]!.path).toBe('~/.config/Claude/claude_desktop_config.json')
    expect(byName(list.servers, 'agyRemote').transport).toMatchObject({ kind: 'http', url: 'https://agy.example/mcp' })
  })

  test('a Codex server turned off in its file says so, and the rows Solus cannot add come last', async () => {
    // WHY: the row tells which agents use a server now (§8.6); Codex loads no server with `enabled = false`.
    write(join(home, '.cursor', 'mcp.json'), { mcpServers: { zebra: { command: NODE, args: ['z.js'] } } })
    codexLayers = [{ name: { type: 'user', file: join(home, '.codex', 'config.toml'), profile: null }, config: { mcp_servers: {
      alpha: { command: './relative', cwd: '.', enabled: false },
      beta: { url: 'https://beta.example/mcp' },
    } }, disabledReason: null }]
    const { servers } = await found().list(ADMIN, OWNER, {})
    expect(servers.map((server) => [server.name, server.state])).toEqual([['beta', 'new'], ['zebra', 'new'], ['alpha', 'unsupported']])
    expect(byName(servers, 'alpha').foundIn[0]).toMatchObject({ file: 'codex-config', turnedOff: true })
    expect(byName(servers, 'beta').foundIn[0]).not.toHaveProperty('turnedOff')
  })

  test('a chat has no project: its folder reads no project file', async () => {
    // WHY: main added chats with no project (docs/plans/projectless-chat.md). The MCP
    // page sends the open session's folder; a chat's folder is the host's own, not a repository.
    write(join(home, '.cursor', 'mcp.json'), { mcpServers: { userTool: { command: NODE, args: ['user.js'] } } })
    const list = await found().list(ADMIN, OWNER, { projectPath: 'solus:new-chat' })
    expect(list.servers.map((server) => server.name)).toEqual(['userTool'])
    expect(list.files.every((file) => file.scope === 'user')).toBe(true)
  })

  test('the same command in two files is one found server that names both files', async () => {
    write(join(project, '.mcp.json'), { mcpServers: { github: { command: NODE, args: ['gh.js'], env: { TOKEN: '${TOKEN}' } } } })
    write(join(home, '.cursor', 'mcp.json'), { mcpServers: { gh: { command: NODE, args: ['gh.js'], env: { OTHER: 'x' } } } })
    const { servers } = await found().list(ADMIN, OWNER, { projectPath: project })
    expect(servers).toHaveLength(1)
    expect(servers[0]!.foundIn.map((place) => place.file)).toEqual(['mcp-json', 'cursor'])
    expect(servers[0]!.projectOnly).toBe(false)
    expect(servers[0]!.transport).toEqual({ kind: 'stdio', command: NODE, args: ['gh.js'], envNames: ['TOKEN', 'OTHER'] })
  })

  test('no value of the files is in an answer', async () => {
    // WHY: a config file holds tokens; only names may leave the host (§8.2).
    write(join(home, '.cursor', 'mcp.json'), { mcpServers: {
      cmd: { command: NODE, args: ['a.js'], env: { API_KEY: SECRET } },
      web: { url: 'https://web.example/mcp', headers: { Authorization: `Bearer ${SECRET}` } },
    } })
    const list = await found().list(ADMIN, OWNER, {})
    expect(JSON.stringify(list)).not.toContain(SECRET)
    expect(byName(list.servers, 'cmd').valuesInFile).toEqual(['API_KEY'])
    expect(byName(list.servers, 'web').valuesInFile).toEqual(['Authorization'])
  })

  test('an sse entry, an entry with ${…}, and an entry Solus cannot read are unsupported', async () => {
    write(join(home, '.claude.json'), { mcpServers: {
      old: { type: 'sse', url: 'https://old.example/sse' },
      expanded: { command: '${HOME}/bin/server' },
      broken: { command: 42 },
    } })
    const { servers } = await found().list(ADMIN, OWNER, {})
    expect(servers.map((server) => [server.name, server.state, server.unsupported])).toEqual([
      ['broken', 'unsupported', 'invalid'],
      ['expanded', 'unsupported', 'expansion'],
      ['old', 'unsupported', 'sse'],
    ])
  })

  test('a file that is not JSON, or a link out of its folder, is listed with why and read no further', async () => {
    write(join(project, '.mcp.json'), '{ not json')
    const outside = join(root, 'outside.json')
    write(outside, { mcpServers: { escaped: { command: NODE } } })
    mkdirSync(join(project, '.cursor'), { recursive: true })
    symlinkSync(outside, join(project, '.cursor', 'mcp.json'))
    const list = await found().list(ADMIN, OWNER, { projectPath: project })
    expect(list.servers).toEqual([])
    expect(list.files.map((file) => [file.file, file.problem])).toEqual([
      ['mcp-json', 'It is not valid JSON.'],
      ['cursor', 'It is a link to a file outside its folder.'],
    ])
  })

  test('a member sees the project files only, and a command there is for an administrator', async () => {
    // WHY: the user files are the host OS user's; a member never reads them (§8.1, §8.6).
    write(join(home, '.claude.json'), { mcpServers: { ownerOnly: { command: NODE, args: ['owner.js'] } } })
    write(join(project, '.mcp.json'), { mcpServers: { repo: { command: NODE, args: ['repo.js'] } } })
    const list = await found().list(MEMBER, 'member-1', { projectPath: project })
    expect(list.servers.map((server) => [server.name, server.state, server.unsupported])).toEqual([['repo', 'unsupported', 'not-allowed']])
    expect(list.files.map((file) => file.scope)).toEqual(['project'])
    const repo = list.servers[0]!
    await expect(found().add(MEMBER, 'member-1', { foundId: repo.foundId, fingerprint: repo.fingerprint, projectPath: project })).rejects.toThrow('Only an administrator of this host can add or change a command.')
  })
})

describe('adding (§8.3, §8.4)', () => {
  test('a project command becomes a stdio integration of that project, with the file values copied on the host', async () => {
    write(join(project, '.mcp.json'), { mcpServers: { repo: { command: NODE, args: ['repo.js'], env: { API_KEY: SECRET } } } })
    const finder = found()
    const repo = byName((await finder.list(ADMIN, OWNER, { projectPath: project })).servers, 'repo')
    const result = await finder.add(ADMIN, OWNER, { foundId: repo.foundId, fingerprint: repo.fingerprint, projectPath: project, useFileValues: true })
    if (result.kind !== 'saved') throw new Error('not saved')
    expect(result.integration.kind).toBe('stdio')
    expect(result.integration.projectKey).toBe(resolveProjectKey(project))
    // The row says "Only in project" (§8.4); the key alone is a hash.
    expect(result.integration.projectName).toBe('project')
    expect(result.integration.url).toBe(stdioServerAddress({ command: NODE, args: ['repo.js'] }))
    expect(submitted).toEqual([{ integrationId: result.integration.id, values: [{ name: 'API_KEY', value: SECRET }] }])
    // The file gave every value: nothing more to ask.
    expect(result.needsValues).toBeUndefined()
    expect(byName((await finder.list(ADMIN, OWNER, { projectPath: project })).servers, 'repo')).toMatchObject({ state: 'added', integrationId: result.integration.id })
  })

  test('a command added without all its values asks for them, so the client opens the values form', async () => {
    // WHY: a found command with environment names cannot start until the person
    // gives the values (§7.6). The add says so; the client then opens the form
    // in the new row instead of leaving a row that only fails to start.
    write(join(home, '.cursor', 'mcp.json'), { mcpServers: {
      named: { command: NODE, args: ['named.js'], env: { API_KEY: SECRET } },
      plain: { command: NODE, args: ['plain.js'] },
    } })
    const finder = found()
    const servers = (await finder.list(ADMIN, OWNER, {})).servers
    // The person chose not to copy the file's value.
    const named = await finder.add(ADMIN, OWNER, { foundId: byName(servers, 'named').foundId, fingerprint: byName(servers, 'named').fingerprint })
    expect(named).toMatchObject({ kind: 'saved', needsValues: true })
    expect(submitted).toEqual([])
    const plain = await finder.add(ADMIN, OWNER, { foundId: byName(servers, 'plain').foundId, fingerprint: byName(servers, 'plain').fingerprint })
    expect(plain.kind === 'saved' && plain.needsValues).toBeFalsy()
  })

  test('a file that changed after the person saw it adds nothing', async () => {
    // WHY: the person approves exactly the command they read, never a newer one (§8.3 step 1).
    const file = join(home, '.cursor', 'mcp.json')
    write(file, { mcpServers: { tool: { command: NODE, args: ['tool.js'] } } })
    const finder = found()
    const seen = byName((await finder.list(ADMIN, OWNER, {})).servers, 'tool')
    write(file, { mcpServers: { tool: { command: NODE, args: ['tool.js', '--evil'] } } })
    expect(await finder.add(ADMIN, OWNER, { foundId: seen.foundId, fingerprint: seen.fingerprint })).toEqual({ kind: 'found-changed' })
    expect(store.list(recordScopeOf(ADMIN), OWNER)).toEqual([])
  })

  test('a command that changed in the file shows as changed, and the add takes the new command', async () => {
    const file = join(home, '.cursor', 'mcp.json')
    write(file, { mcpServers: { tool: { command: NODE, args: ['v1.js'] } } })
    const finder = found()
    const first = byName((await finder.list(ADMIN, OWNER, {})).servers, 'tool')
    const added = await finder.add(ADMIN, OWNER, { foundId: first.foundId, fingerprint: first.fingerprint })
    if (added.kind !== 'saved') throw new Error('not saved')

    write(file, { mcpServers: { tool: { command: NODE, args: ['v2.js'] } } })
    const changed = byName((await finder.list(ADMIN, OWNER, { refresh: true })).servers, 'tool')
    expect(changed).toMatchObject({ state: 'changed', integrationId: added.integration.id })
    const updated = await finder.add(ADMIN, OWNER, { foundId: changed.foundId, fingerprint: changed.fingerprint })
    if (updated.kind !== 'saved') throw new Error('not saved')
    expect(updated.integration.id).toBe(added.integration.id)
    expect(updated.integration.launch).toEqual({ command: NODE, args: ['v2.js'] })
  })

  test('a URL is added when the CLI skip calls it the same server, a slash or the case of the host aside', async () => {
    // WHY: "added" says Solus runs this server, so each Solus run leaves out the
    // CLI's copy (§8.5). The two rules must agree, or a row says added for a
    // copy the run still loads, or offers to add a server Solus already runs.
    store.create({ name: 'Linear', url: 'https://mcp.linear.app/mcp', slug: 'linear', auth: { kind: 'none' } }, 'local', OWNER)
    write(join(home, '.cursor', 'mcp.json'), { mcpServers: {
      slash: { url: 'https://MCP.linear.app/mcp/' },
      query: { url: 'https://mcp.linear.app/mcp?team=1' },
    } })
    const { servers } = await found().list(ADMIN, OWNER, {})
    expect(byName(servers, 'slash').state).toBe('added')
    expect(byName(servers, 'query').state).toBe('new')
  })

  test('a URL server keeps the static OAuth client its file names, so the person does not enter it again', async () => {
    // WHY: `claude mcp add --client-id` saves a client for a server that does
    // not register Solus by itself. Without it the sign-in stops at "enter
    // your OAuth client", for a client the person already gave once.
    fake.options.registration = false
    write(join(home, '.claude.json'), { mcpServers: {
      withClient: { type: 'http', url: fake.mcpUrl, oauth: { clientId: 'static-client-1', callbackPort: 8080 } },
      expanded: { type: 'http', url: `${fake.mcpUrl}?x=1`, oauth: { clientId: '${CLIENT_ID}' } },
    } })
    const owner = found()
    const { servers } = await owner.list(ADMIN, OWNER, {})
    const server = byName(servers, 'withClient')
    const result = await owner.add(ADMIN, OWNER, { foundId: server.foundId, fingerprint: server.fingerprint })
    expect(result.kind === 'saved' && result.integration.auth).toMatchObject({ kind: 'oauth', clientId: 'static-client-1' })
    expect(ownerClients).toEqual([{ clientId: 'static-client-1' }])

    // A `${…}` client ID is a reference Solus does not expand: the add saves no client.
    const expanded = byName(servers, 'expanded')
    ownerClients = []
    await owner.add(ADMIN, OWNER, { foundId: expanded.foundId, fingerprint: expanded.fingerprint })
    expect(ownerClients).toEqual([])
    fake.options.registration = true
  })

  test('a URL that changed in a file is the same write as Settings: the CLI copy comes back, and a project record is no profile entry', async () => {
    // WHY: Found and Settings write through one IntegrationWrites. Before, Found's
    // address change kept the CLI skips of the old address (§8.5), and told the
    // profile by its own rule (§8.4).
    const repo = store.create({ name: 'repo', url: 'https://old-repo.example/mcp', slug: 'repo', auth: { kind: 'none' }, projectKey: resolveProjectKey(project), projectName: 'project' }, 'local', OWNER)
    const user = store.create({ name: 'user', url: 'https://old-user.example/mcp', slug: 'user', auth: { kind: 'none' } }, 'local', OWNER)
    for (const integration of [repo, user]) cliSkipLog.record(OWNER, 'claude-code', [integration.id], [{ integrationId: integration.id, serverName: integration.name }])
    write(join(project, '.mcp.json'), { mcpServers: { repo: { type: 'http', url: fake.mcpUrl } } })
    write(join(home, '.cursor', 'mcp.json'), { mcpServers: { user: { url: fake.modernMcpUrl } } })
    const finder = found()
    const servers = (await finder.list(ADMIN, OWNER, { projectPath: project })).servers
    for (const name of ['repo', 'user']) {
      const changed = byName(servers, name)
      expect(changed.state).toBe('changed')
      const result = await finder.add(ADMIN, OWNER, { foundId: changed.foundId, fingerprint: changed.fingerprint, projectPath: project })
      if (result.kind !== 'saved') throw new Error('not saved')
      expect(result.integration.url).toBe(name === 'repo' ? fake.mcpUrl : fake.modernMcpUrl)
    }
    expect(cliSkipLog.for(repo.id, OWNER)).toEqual([])
    expect(cliSkipLog.for(user.id, OWNER)).toEqual([])
    expect(profileSaves).toEqual(['user'])
  })
})

describe('the lifecycle of a found server in its file (§8.8)', () => {
  const FAKE_STDIO = join(import.meta.dir, '..', '..', 'fixtures', 'fake-stdio-mcp-server.mjs')
  const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

  test('Claude Code\'s list for the project marks a server it does not load, and an administrator may change it', async () => {
    // WHY: Claude Code turns a server off for one project. The row must say so, or "loads it" is a lie.
    write(join(home, '.claude.json'), { mcpServers: { paper: { command: NODE, args: ['paper.js'] } }, projects: { [project]: { disabledMcpServers: ['paper'] } } })
    const [server] = (await found().list(ADMIN, OWNER, { projectPath: project })).servers
    expect(server!.foundIn[0]).toMatchObject({ file: 'claude-json', turnedOff: true, canTurnOff: true, canDelete: true, filePath: join(home, '.claude.json') })
  })

  test('a member may change nothing: the file is the host user\'s', async () => {
    write(join(project, '.mcp.json'), { mcpServers: { repo: { type: 'http', url: 'https://repo.example/mcp' } } })
    const [server] = (await found().list(MEMBER, 'member-1', { projectPath: project })).servers
    expect(server!.foundIn[0]).not.toHaveProperty('canDelete')
    expect(server!.foundIn[0]).not.toHaveProperty('canTurnOff')
  })

  test('turning a Claude Code server off writes the project\'s list, and on takes it out again', async () => {
    const claudeJson = join(home, '.claude.json')
    write(claudeJson, { numStartups: 7, mcpServers: { paper: { command: NODE, args: ['paper.js'] } } })
    const owner = found()
    const [server] = (await owner.list(ADMIN, OWNER, { projectPath: project })).servers
    const place = { file: 'claude-json' as const, path: '~/.claude.json', name: 'paper' }
    expect(await owner.change(ADMIN, { foundId: server!.foundId, fingerprint: server!.fingerprint, projectPath: project, place, change: 'turn-off' })).toEqual({ kind: 'saved' })
    // The rest of Claude Code's file stays as it was.
    expect(readJson(claudeJson)).toMatchObject({ numStartups: 7, projects: { [project]: { disabledMcpServers: ['paper'] } } })
    await owner.change(ADMIN, { foundId: server!.foundId, fingerprint: server!.fingerprint, projectPath: project, place, change: 'turn-on' })
    expect(readJson(claudeJson).projects[project]).toEqual({})
  })

  test('a delete from Cursor\'s file takes out that entry only', async () => {
    const cursor = join(home, '.cursor', 'mcp.json')
    write(cursor, { mcpServers: { gone: { url: 'https://gone.example/mcp' }, kept: { url: 'https://kept.example/mcp' } } })
    const owner = found()
    const server = byName((await owner.list(ADMIN, OWNER, {})).servers, 'gone')
    await owner.change(ADMIN, { foundId: server.foundId, fingerprint: server.fingerprint, place: { file: 'cursor', path: '~/.cursor/mcp.json', name: 'gone' }, change: 'delete' })
    expect(readJson(cursor)).toEqual({ mcpServers: { kept: { url: 'https://kept.example/mcp' } } })
  })

  test('Claude Code and Codex delete through their own CLIs, and Codex turns a server off through its app-server', async () => {
    // WHY: both tools rewrite their own files; Solus writing beside them would lose a change.
    write(join(home, '.claude.json'), { mcpServers: { paper: { command: NODE, args: ['paper.js'] } } })
    const codexFile = join(home, '.codex', 'config.toml')
    codexLayers = [{ name: { type: 'user', file: codexFile, profile: null }, config: { mcp_servers: { repl: { command: NODE, args: ['repl.js'] } } }, disabledReason: null }]
    const runs: Array<{ program: string; args: string[]; cwd: string }> = []
    const codexWrites: Array<{ keyPath: string; value: boolean; filePath: string }> = []
    const owner = found(new ConfigWrites({
      run: async (program, args, cwd) => { runs.push({ program, args, cwd }) },
      codexWrite: async (keyPath, value, filePath) => { codexWrites.push({ keyPath, value, filePath }) },
    }))
    const servers = (await owner.list(ADMIN, OWNER, { projectPath: project })).servers
    const paper = byName(servers, 'paper')
    const repl = byName(servers, 'repl')
    await owner.change(ADMIN, { foundId: paper.foundId, fingerprint: paper.fingerprint, projectPath: project, place: { file: 'claude-json', path: '~/.claude.json', name: 'paper' }, change: 'delete' })
    await owner.change(ADMIN, { foundId: repl.foundId, fingerprint: repl.fingerprint, projectPath: project, place: { file: 'codex-config', path: '~/.codex/config.toml', name: 'repl' }, change: 'delete' })
    await owner.change(ADMIN, { foundId: repl.foundId, fingerprint: repl.fingerprint, projectPath: project, place: { file: 'codex-config', path: '~/.codex/config.toml', name: 'repl' }, change: 'turn-off' })
    expect(runs).toEqual([
      { program: 'claude', args: ['mcp', 'remove', 'paper', '--scope', 'user'], cwd: home },
      { program: 'codex', args: ['mcp', 'remove', 'repl'], cwd: home },
    ])
    expect(codexWrites).toEqual([{ keyPath: 'mcp_servers.repl.enabled', value: false, filePath: codexFile }])
  })

  test('a change to an entry that changed after the person saw it touches nothing', async () => {
    const cursor = join(home, '.cursor', 'mcp.json')
    write(cursor, { mcpServers: { tool: { url: 'https://one.example/mcp' } } })
    const owner = found()
    const [server] = (await owner.list(ADMIN, OWNER, {})).servers
    write(cursor, { mcpServers: { tool: { url: 'https://two.example/mcp' } } })
    const result = await owner.change(ADMIN, { foundId: server!.foundId, fingerprint: server!.fingerprint, place: { file: 'cursor', path: '~/.cursor/mcp.json', name: 'tool' }, change: 'delete' })
    expect(result).toEqual({ kind: 'found-changed' })
    expect(readJson(cursor).mcpServers.tool.url).toBe('https://two.example/mcp')
  })

  test('a test starts the command of the file once and reads its tools', async () => {
    write(join(home, '.cursor', 'mcp.json'), { mcpServers: { fake: { command: NODE, args: [FAKE_STDIO, '--tools', 'search,index'] } } })
    const owner = found()
    const [server] = (await owner.list(ADMIN, OWNER, {})).servers
    const result = await owner.test(ADMIN, { foundId: server!.foundId, fingerprint: server!.fingerprint })
    expect(result.kind === 'tools' && result.tools.map((tool) => tool.name)).toEqual(['search', 'index'])
  })
})
