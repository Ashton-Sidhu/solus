import { beforeEach, describe, expect, test } from 'bun:test'
import type { FoundServer, Integration, IntegrationFoundAddRequest, IntegrationFoundAddResult } from '@solus/contracts/integration-types'
import { addMcpServerAgentTool, installAddMcpServerTool } from '@solus/server/integrations/add-mcp-server-tool'
import { runtimeInstructions } from '@solus/server/execution/agents/runtime-instructions'
import { withActingScope } from '@solus/server/vault/acting-scope'
import { HOST_IDENTITY } from '@solus/server/execution/seats/acting-identity'

/**
 * `add_mcp_server` (docs/plans/mcp-first-class.md §8.7): the user told one agent
 * to install an MCP server, and every agent gets it with no further question.
 * What matters: it adds what the agent's own file holds, with the file's values;
 * a command starts once so its tools are there for the next turn; and a server
 * that only a repository file holds is never added by an agent.
 */

const PERSON = 'person-1'

let servers: FoundServer[] = []
let adds: IntegrationFoundAddRequest[] = []
let starts: string[] = []
let asked: string[] = []
let startFails = false
let addResult: IntegrationFoundAddResult

function found(overrides: Partial<FoundServer> & Pick<FoundServer, 'name'>): FoundServer {
  return {
    foundId: `f-${overrides.name}`,
    fingerprint: `p-${overrides.name}`,
    foundIn: [{ kind: 'file', file: 'claude-json', scope: 'user', path: '~/.claude.json', filePath: '/home/me/.claude.json', name: overrides.name }],
    transport: { kind: 'stdio', command: 'uvx', args: ['opensearch-mcp-server-py'], envNames: ['OPENSEARCH_URL'] },
    state: 'new',
    projectOnly: false,
    valuesInFile: ['OPENSEARCH_URL'],
    ...overrides,
  }
}

function integration(launch: boolean): Integration {
  return {
    id: 'int-1', organizationId: 'local', ownerKey: PERSON, kind: 'mcp', slug: 'opensearch', name: 'opensearch', url: '',
    auth: { kind: 'env', names: ['OPENSEARCH_URL'] },
    ...(launch && { launch: { command: 'uvx', args: ['opensearch-mcp-server-py'] } }),
    disabledTools: [], createdBy: null, createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z',
  }
}

const context = {
  provider: 'claude' as const,
  cwd: '/work/project',
  sessionId: () => 's1',
  abortSignal: new AbortController().signal,
  parentToolUseId: () => undefined,
  emit: () => {},
}

function run(name: string, personKey: string | null = PERSON) {
  return withActingScope({ identity: HOST_IDENTITY, personKey }, () => addMcpServerAgentTool.execute({ name }, context))
}

beforeEach(() => {
  servers = []
  adds = []
  starts = []
  asked = []
  startFails = false
  addResult = { kind: 'saved', integration: integration(true) }
  installAddMcpServerTool({
    found: {
      list: async () => ({ servers, files: [] }),
      add: async (_principal, _owner, request) => { adds.push(request); return addResult },
    },
    start: async (integrationId) => {
      if (startFails) throw new Error('spawn uvx ENOENT')
      starts.push(integrationId)
      return { era: 'modern', instructions: null, capabilities: { prompts: false, resources: false, resourceSubscribe: false, tasks: false } }
    },
    askToConnect: async (added) => { asked.push(added.id); return { ok: true, text: 'card' } },
  })
})

describe('add_mcp_server', () => {
  test('a server the agent installed for its CLI is added with the file values and started once, with no question', async () => {
    servers = [found({ name: 'opensearch' })]
    const result = await run('opensearch')
    expect(result.ok).toBe(true)
    expect(adds).toEqual([{ foundId: 'f-opensearch', fingerprint: 'p-opensearch', projectPath: '/work/project', useFileValues: true }])
    // WHY: a command's tools exist only after its first start (§7.5); without it the next turn has none.
    expect(starts).toEqual(['int-1'])
    expect(asked).toEqual([])
    expect(JSON.parse(result.text)).toMatchObject({ added: true, started: true })
  })

  test('a Codex server is found by its name in config.toml', async () => {
    servers = [found({ name: 'search', foundIn: [{ kind: 'file', file: 'codex-config', scope: 'user', path: '~/.codex/config.toml', filePath: '/home/me/.codex/config.toml', name: 'opensearch' }] })]
    expect((await run('opensearch')).ok).toBe(true)
    expect(adds).toHaveLength(1)
  })

  test('a server only a repository file holds is not added by an agent', async () => {
    // WHY (§8): a clone can hold any command. The person reads it and adds it in Found on this host.
    servers = [found({ name: 'repo', foundIn: [{ kind: 'file', file: 'mcp-json', scope: 'project', path: '.mcp.json', filePath: '/work/project/.mcp.json', name: 'repo' }], projectOnly: true })]
    const result = await run('repo')
    expect(result.ok).toBe(false)
    expect(result.text).toContain('Settings → MCP')
    expect(adds).toEqual([])
  })

  test('Claude Code\'s project entry is in the person\'s own file, so it is added', async () => {
    servers = [found({ name: 'local', foundIn: [{ kind: 'file', file: 'claude-json', scope: 'project', path: '~/.claude.json', filePath: '/home/me/.claude.json', name: 'local' }], projectOnly: true })]
    expect((await run('local')).ok).toBe(true)
    expect(adds).toHaveLength(1)
  })

  test('a server that needs values the file does not give asks the person in a card', async () => {
    servers = [found({ name: 'opensearch', valuesInFile: [] })]
    addResult = { kind: 'saved', integration: integration(true), needsValues: true }
    await run('opensearch')
    expect(asked).toEqual(['int-1'])
    expect(starts).toEqual([])
  })

  test('a failed first start keeps the server and says so', async () => {
    servers = [found({ name: 'opensearch' })]
    startFails = true
    const result = await run('opensearch')
    expect(result.ok).toBe(true)
    expect(JSON.parse(result.text)).toMatchObject({ added: true, started: false, error: 'spawn uvx ENOENT' })
  })

  test('a name in no file, an added server, and a turn with no person add nothing', async () => {
    expect((await run('missing')).text).toContain('claude mcp add')
    servers = [found({ name: 'opensearch', state: 'added', integrationId: 'int-1' })]
    expect(JSON.parse((await run('opensearch')).text)).toMatchObject({ alreadyAdded: true })
    expect((await run('opensearch', null)).ok).toBe(false)
    expect(adds).toEqual([])
  })

  test('a run with the tool learns to call it after an install for its CLI', () => {
    // WHY: the tool loads behind tool search; without the sentence an agent that ran `claude mcp add` never looks for it.
    const runtime = { harness: 'Claude Code' as const, model: 'opus', reasoningEffort: 'high' }
    const sentence = 'call add_mcp_server with its name'
    expect(runtimeInstructions(runtime, [addMcpServerAgentTool])).toContain(sentence)
    expect(runtimeInstructions(runtime, [])).not.toContain(sentence)
  })

  test('a refusal of the add, such as a member who may not add a command, reaches the agent', async () => {
    servers = [found({ name: 'opensearch' })]
    installAddMcpServerTool({
      found: { list: async () => ({ servers, files: [] }), add: async () => { throw new Error('Only an administrator of this host can add or change a command.') } },
      start: async () => { throw new Error('not reached') },
      askToConnect: async () => ({ ok: true, text: '' }),
    })
    const result = await run('opensearch')
    expect(result).toEqual({ ok: false, text: 'Only an administrator of this host can add or change a command.' })
  })
})
