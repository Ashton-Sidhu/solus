import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { Integration } from '@solus/contracts/integration-types'
import type { UpstreamTool } from '@solus/server/integrations/gateway'
import { TEST_HANDLER_CTX } from '../helpers/handler-ctx'

/**
 * The CLI skip (docs/plans/mcp-first-class.md §8.5): a run leaves out the
 * provider CLI's own copy of each server that Solus runs in that run, and no
 * other. Claude Code gets `deniedMcpServers` in the run's flag settings; Codex
 * gets `mcp_servers.<name>.enabled = false` in the thread config.
 */

const queries: Options[] = []
let cliPath: Promise<string>
const realCliEnv = await import('@solus/server/cli-env')
mock.module('@solus/server/cli-env', () => ({ ...realCliEnv, warmCliPath: () => cliPath }))
const realSdk = await import('@anthropic-ai/claude-agent-sdk')
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: ({ options }: { options: Options }) => {
    queries.push(options)
    return Object.assign((async function* () {
      yield { type: 'result', subtype: 'success', result: 'done' }
    })(), { supportedCommands: async () => [] })
  },
}))

const { ClaudeAgent } = await import('@solus/server/execution/agents/claude/claude-agent')
const { claudeDeniedMcpServers } = await import('@solus/server/execution/agents/claude/claude-cli-skip')
const { codexSkipConfig, readCodexSkipConfig } = await import('@solus/server/execution/agents/codex/codex-cli-skip')
const { CliSkipLog, cliSkipLog, cliSkipOf, sameServerAddress } = await import('@solus/server/integrations/cli-skips')
const { integrationToolbox, setIntegrationGateway } = await import('@solus/server/integrations/integration-tools')
const { ownerKeyOf } = await import('@solus/server/admission/actor')
const { resolveProjectKey } = await import('@solus/server/project-config/project-config')
const { withActingScope } = await import('@solus/server/vault/acting-scope')
const { HOST_IDENTITY } = await import('@solus/server/execution/seats/acting-identity')

const OWNER = ownerKeyOf(TEST_HANDLER_CTX.actor)
const url = (value: string) => ({ kind: 'url' as const, url: value })
const command = (program: string, ...args: string[]) => ({ kind: 'command' as const, command: program, args })

let directory: string
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'solus-cli-skip-'))
  // The run reads this as the user's Claude settings; never the developer's own.
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'solus-cli-skip-config-'))
  const executable = join(directory, process.platform === 'win32' ? 'claude.exe' : 'claude')
  writeFileSync(executable, '#!/bin/sh\nexit 0\n')
  chmodSync(executable, 0o755)
  cliPath = Promise.resolve(directory)
  queries.length = 0
})

afterEach(() => {
  setIntegrationGateway(null)
  rmSync(directory, { recursive: true, force: true })
  rmSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true, force: true })
})

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
})

describe('equal addresses', () => {
  test('a slash at the end, the case of the host, and the default port do not make another server', () => {
    // WHY: a person pastes the same server with and without the slash; the agent must still see it once.
    expect(sameServerAddress(url('https://mcp.linear.app/mcp'), url('https://mcp.linear.app/mcp/'))).toBe(true)
    expect(sameServerAddress(url('https://MCP.Linear.app:443/mcp'), url('https://mcp.linear.app/mcp'))).toBe(true)
    expect(sameServerAddress(url('https://mcp.linear.app/mcp#top'), url('https://mcp.linear.app/mcp'))).toBe(true)
    expect(sameServerAddress(url('https://example.test'), url('https://example.test/'))).toBe(true)
  })

  test('a server that only looks similar is another server', () => {
    // WHY: leaving out a server Solus does not run takes tools away from the agent.
    expect(sameServerAddress(url('https://mcp.linear.app/mcp'), url('https://mcp.linear.app/mcp-admin'))).toBe(false)
    expect(sameServerAddress(url('https://mcp.linear.app/mcp?team=a'), url('https://mcp.linear.app/mcp?team=b'))).toBe(false)
    expect(sameServerAddress(url('http://mcp.linear.app/mcp'), url('https://mcp.linear.app/mcp'))).toBe(false)
    expect(sameServerAddress(url('not a url'), url('not a url'))).toBe(false)
    expect(sameServerAddress(command('npx', '-y', 'server', '/data'), command('npx', '-y', '/data', 'server'))).toBe(false)
    expect(sameServerAddress(command('npx', '-y', 'server'), command('/usr/local/bin/npx', '-y', 'server'))).toBe(false)
    expect(sameServerAddress(command('npx', '-y', 'server'), command('npx', '-y', 'server', '--read-only'))).toBe(false)
    expect(sameServerAddress(url('stdio:abc'), command('stdio:abc'))).toBe(false)
  })

  test('the same command and arguments in the same order are one server', () => {
    expect(sameServerAddress(command('npx', '-y', 'server', '/data'), command('npx', '-y', 'server', '/data'))).toBe(true)
  })

  test('a server in the host process has no address a CLI could have', () => {
    const base = { id: 'i', url: 'solus:browser' }
    expect(cliSkipOf({ ...base, kind: 'solus' })).toBeNull()
    expect(cliSkipOf({ ...base, kind: 'mcp', url: 'https://x.test/mcp' })).toEqual({ integrationId: 'i', address: url('https://x.test/mcp') })
    expect(cliSkipOf({ ...base, kind: 'stdio', url: 'stdio:0123456789abcdef', launch: { command: 'npx', args: ['-y', 's'] } }))
      .toEqual({ integrationId: 'i', address: command('npx', '-y', 's') })
  })
})

describe('Claude Code', () => {
  const linear = { integrationId: 'linear', address: url('https://mcp.linear.app/mcp/') }
  const files = { integrationId: 'files', address: command('npx', '-y', '@modelcontextprotocol/server-filesystem', '/data') }

  test('denies each server by its address, a URL in both forms, and reports one skip for each', () => {
    // WHY: the CLI matches a URL exactly, except for the host's case and the default port (proven in C2).
    expect(claudeDeniedMcpServers([linear, files])).toEqual({
      denied: [
        { serverUrl: 'https://mcp.linear.app/mcp' },
        { serverUrl: 'https://mcp.linear.app/mcp/' },
        { serverCommand: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '/data'] },
      ],
      applied: [{ integrationId: 'linear' }, { integrationId: 'files' }],
    })
  })

  test('a URL with a wildcard is not denied, because it could match another server', () => {
    expect(claudeDeniedMcpServers([{ integrationId: 'w', address: url('https://*.example.test/mcp') }])).toEqual({ denied: [], applied: [] })
  })

  test("the run's flag settings carry the deny list and keep the other flag settings", async () => {
    const reports: unknown[] = []
    const run = new ClaudeAgent().run({ prompt: 'hello', cwd: directory, cliSkip: { servers: [files], report: (...report) => reports.push(report) } })
    for await (const _ of run.events) { /* drain */ }
    await run.result
    expect(queries[0].settings).toEqual({
      showThinkingSummaries: true,
      deniedMcpServers: [{ serverCommand: ['npx', '-y', '@modelcontextprotocol/server-filesystem', '/data'] }],
    })
    // WHY: the deny list removes one server; `strictMcpConfig` would remove every server of the CLI.
    expect(queries[0].strictMcpConfig).toBe(false)
    expect(reports).toEqual([['claude-code', [{ integrationId: 'files' }]]])
  })

  test('a bare run loads no server of the CLI, so it denies and reports nothing', async () => {
    const reports: unknown[] = []
    const run = new ClaudeAgent().run({ prompt: 'hello', cwd: directory, bare: { webAccess: false }, cliSkip: { servers: [files], report: (...report) => reports.push(report) } })
    for await (const _ of run.events) { /* drain */ }
    await run.result
    expect(queries[0].settings?.deniedMcpServers).toBeUndefined()
    expect(queries[0].strictMcpConfig).toBe(true)
    expect(reports).toEqual([])
  })

  test('a run with no server of Solus denies nothing', async () => {
    const run = new ClaudeAgent().run({ prompt: 'hello', cwd: directory, cliSkip: { servers: [], report: () => {} } })
    for await (const _ of run.events) { /* drain */ }
    await run.result
    expect(queries[0].settings).toEqual({ showThinkingSummaries: true })
  })
})

describe('Codex', () => {
  const read = {
    config: {
      mcp_servers: {
        linear: { url: 'https://mcp.linear.app/mcp', enabled: true },
        files: { command: 'npx', args: ['-y', 'server', '/data'], env: { TOKEN: 'from the file' }, enabled: true },
        lookalike: { command: 'npx', args: ['-y', '/data', 'server'], enabled: true },
        mine: { command: 'my-server', enabled: true },
        off: { url: 'https://off.test/mcp', enabled: false },
      },
    },
    origins: {
      'mcp_servers.linear.url': { name: { type: 'user' as const, file: '/home/me/.codex/config.toml', profile: null }, version: 'a' },
      'mcp_servers.files.command': { name: { type: 'project' as const, dotCodexFolder: '/repo/.codex' }, version: 'b' },
    },
  }
  const servers = [
    { integrationId: 'linear', address: url('https://mcp.linear.app/mcp/') },
    { integrationId: 'files', address: command('npx', '-y', 'server', '/data') },
    { integrationId: 'off', address: url('https://off.test/mcp') },
  ]

  test('turns off each configured server with the address of one Solus runs, and names where it is', () => {
    // WHY: the environment holds the person's values, not the server, so a copy with other values is still the same server.
    expect(codexSkipConfig(read, servers)).toEqual({
      config: { 'mcp_servers.linear.enabled': false, 'mcp_servers.files.enabled': false },
      applied: [
        { integrationId: 'linear', serverName: 'linear', scope: 'user' },
        { integrationId: 'files', serverName: 'files', scope: 'project' },
      ],
    })
  })

  test('a server Solus does not run is never turned off', () => {
    const { config } = codexSkipConfig(read, servers)
    expect(Object.keys(config)).not.toContain('mcp_servers.mine.enabled')
    expect(Object.keys(config)).not.toContain('mcp_servers.lookalike.enabled')
  })

  test('the read happens on the run client only when there is a server to leave out', async () => {
    const requests: Array<{ method: string; params: unknown }> = []
    const client = { request: async (method: string, params: unknown) => { requests.push({ method, params }); return read } }
    const reports: unknown[] = []
    const report = (...entry: unknown[]) => reports.push(entry)
    // SAFETY: the stand-in answers the one method this code sends.
    const asClient = client as unknown as Parameters<typeof readCodexSkipConfig>[0]
    expect(await readCodexSkipConfig(asClient, '/repo', { cliSkip: { servers: [], report } })).toEqual({})
    expect(await readCodexSkipConfig(asClient, '/repo', { bare: { webAccess: false }, cliSkip: { servers, report } })).toEqual({})
    expect(requests).toEqual([])
    expect(await readCodexSkipConfig(asClient, '/repo', { cliSkip: { servers, report } })).toEqual({ 'mcp_servers.linear.enabled': false, 'mcp_servers.files.enabled': false })
    expect(requests).toEqual([{ method: 'config/read', params: { cwd: '/repo' } }])
    // The empty run still reports, so it clears what an earlier run wrote; the bare run reports nothing.
    expect(reports).toHaveLength(2)
  })

  test('a failed read leaves every copy loaded and reports nothing', async () => {
    const reports: unknown[] = []
    const client = { request: async () => { throw new Error('closed') } }
    // SAFETY: the stand-in answers the one method this code sends.
    const asClient = client as unknown as Parameters<typeof readCodexSkipConfig>[0]
    expect(await readCodexSkipConfig(asClient, '/repo', { cliSkip: { servers, report: (...entry) => reports.push(entry) } })).toEqual({})
    expect(reports).toEqual([])
  })
})

/** A gateway stand-in: the toolbox reads the records, their tool lists, the accounts, and the facts. */
function gatewayWith(integrations: Integration[], tools: Record<string, UpstreamTool[]>) {
  return {
    store: { list: () => integrations, get: (id: string) => integrations.find((integration) => integration.id === id) ?? null },
    toolsFor: async (id: string) => tools[id] ?? [],
    accountChoices: () => [],
    factsFor: async () => ({ instructions: null }),
  }
}

function record(id: string, fields: Partial<Integration>): Integration {
  return {
    id, organizationId: 'local', ownerKey: OWNER ?? 'local', kind: 'mcp', slug: id, name: id, url: `https://${id}.test/mcp`,
    auth: { kind: 'none' }, disabledTools: [], createdAt: '', updatedAt: '', ...fields,
  }
}

const tool = (name: string): UpstreamTool => ({ name, inputSchema: { type: 'object' } })
/** A project key asks git for the project root, which runs as the run's person. */
const asOwner = <T>(work: () => Promise<T>) => withActingScope({ identity: HOST_IDENTITY, personKey: OWNER }, work)

describe('which servers a run leaves out', () => {
  test('each server that adds a tool to the run, a project server only in its project', async () => {
    const projectA = mkdtempSync(join(directory, 'a-'))
    const projectB = mkdtempSync(join(directory, 'b-'))
    const integrations = [
      record('linear', {}),
      record('repo', { projectKey: await asOwner(async () => resolveProjectKey(projectA)) }),
      record('quiet', { disabledTools: ['only'] }),
      record('browser', { kind: 'solus', url: 'solus:browser' }),
    ]
    // SAFETY: the toolbox reads only the four members the stand-in has.
    setIntegrationGateway(gatewayWith(integrations, { linear: [tool('a')], repo: [tool('b')], quiet: [tool('only')], browser: [tool('c')] }) as never)
    const skipped = async (projectPath?: string) => (await asOwner(() => integrationToolbox(TEST_HANDLER_CTX.actor, projectPath))).cliSkip.servers.map((skip) => skip.integrationId)
    // WHY: a project server's tools reach only that project's runs, so only those runs may take the CLI's copy away.
    expect(await skipped(projectA)).toEqual(['linear', 'repo'])
    expect(await skipped(projectB)).toEqual(['linear'])
    // WHY: every tool off gives the agent nothing from Solus, so the CLI keeps its copy.
    expect(await skipped()).not.toContain('quiet')
  })

  test("a run's report shows in the facts, and the skip ends when the integration goes", async () => {
    const integrations = [record('linear', {})]
    // SAFETY: the toolbox reads only the four members the stand-in has.
    setIntegrationGateway(gatewayWith(integrations, { linear: [tool('a')] }) as never)
    const changed: string[] = []
    cliSkipLog.onChanged((id) => changed.push(id))
    const { cliSkip } = await integrationToolbox(TEST_HANDLER_CTX.actor)
    cliSkip.report('codex', [{ integrationId: 'linear', serverName: 'linear', scope: 'user' }])
    cliSkip.report('claude-code', [{ integrationId: 'linear' }])
    expect(cliSkipLog.for('linear', OWNER)).toEqual([{ provider: 'claude-code' }, { provider: 'codex', serverName: 'linear', scope: 'user' }])
    expect(changed).toEqual(['linear', 'linear'])
    // WHY: the same skip at the next run is not news; a client reads the facts again only on a change.
    cliSkip.report('codex', [{ integrationId: 'linear', serverName: 'linear', scope: 'user' }])
    expect(changed).toHaveLength(2)

    cliSkipLog.forget('linear')
    expect(cliSkipLog.for('linear', OWNER)).toEqual([])
    expect(changed).toHaveLength(3)

    // Removed: the next run has no server of Solus, so nothing is left out.
    integrations.length = 0
    expect((await integrationToolbox(TEST_HANDLER_CTX.actor)).cliSkip.servers).toEqual([])
  })
})

describe('the log', () => {
  test('a run that no longer leaves a copy out clears what the last one wrote, for its provider only', () => {
    const log = new CliSkipLog()
    log.record('me', 'codex', ['linear'], [{ integrationId: 'linear', serverName: 'linear', scope: 'project' }])
    log.record('me', 'claude-code', ['linear'], [{ integrationId: 'linear' }])
    // A Codex run in a project without the copy: the Codex entry goes, Claude's stays.
    log.record('me', 'codex', ['linear'], [])
    expect(log.for('linear', 'me')).toEqual([{ provider: 'claude-code' }])
    // Another person's runs are theirs.
    expect(log.for('linear', 'someone else')).toEqual([])
  })
})

describe('what the person sees', () => {
  test('each copy says which CLI left it out and where it is; Claude Code has no name to give', async () => {
    const { cliSkipLines } = await import('@solus/client-core/mcp-cli-skips')
    // WHY: a person who finds a server missing from a CLI must see that Solus took it, and from which file.
    expect(cliSkipLines([
      { provider: 'claude-code' },
      { provider: 'codex', serverName: 'linear', scope: 'user' },
      { provider: 'codex', serverName: 'files', scope: 'project' },
      { provider: 'codex', serverName: 'managed' },
    ])).toEqual([
      'Claude Code does not load its own copy at this address.',
      'Codex does not load “linear” from ~/.codex/config.toml.',
      'Codex does not load “files” from .codex/config.toml in the project.',
      'Codex does not load “managed”.',
    ])
    expect(cliSkipLines([])).toEqual([])
  })
})
