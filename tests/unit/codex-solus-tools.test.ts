import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { z } from 'zod'
import { DatabaseSync } from './helpers/bun-sqlite'
import { CodexAppServerClient } from '@solus/server/execution/agents/codex/codex-agent'
import { codexSolusServers, SolusCallItems } from '@solus/server/execution/agents/codex/codex-solus-tools'
import type { AgentTool } from '@solus/server/execution/agents/tools/agent-tool'
import type { NormalizedEvent } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync }))

let CodexBackend: typeof import('@solus/server/execution/agents/codex/codex-backend')['CodexBackend']
let CodexTurnNormalizer: typeof import('@solus/server/execution/agents/codex/codex-event-normalizer')['CodexTurnNormalizer']

beforeAll(async () => {
  ;({ CodexBackend } = await import('@solus/server/execution/agents/codex/codex-backend'))
  ;({ CodexTurnNormalizer } = await import('@solus/server/execution/agents/codex/codex-event-normalizer'))
})

const ITEM_ID = 'call_7Hq2'
const access = { url: 'http://127.0.0.1:1/mcp', authorization: 'Bearer t', release: () => {} }

function tool(name: string, alwaysLoad = false): AgentTool {
  return { name, description: name, inputFields: { region: z.string().optional() }, requiresApproval: false, alwaysLoad, execute: async () => ({ ok: true, text: 'ok' }) }
}

/** A Codex backend with one run on `thread-a`, its app server faked. */
function backendWithRun(permissionMode: 'supervised' | 'full-access' = 'supervised') {
  const backend = new CodexBackend()
  const client = new CodexAppServerClient({})
  const responses: unknown[] = []
  client.respond = (_id, result) => { responses.push(result) }
  Reflect.apply(Reflect.get(backend, 'attachClient') as (client: CodexAppServerClient) => void, backend, [client])
  const handle = { client, threadId: 'thread-a', permissionMode, sawPermissionRequest: false, solusCalls: new SolusCallItems(), normalizer: new CodexTurnNormalizer({ planMode: false }) }
  ;(Reflect.get(backend, 'activeRuns') as Map<string, object>).set('thread-a', handle)
  const events: NormalizedEvent[] = []
  backend.on('normalized', (_threadId: string, event: NormalizedEvent) => { events.push(event) })
  return { backend, client, handle, responses, events }
}

// WHY: Codex reaches Solus tools as MCP servers on the host's endpoint
// (plans/035 §9). A tool that carries guidance must never be deferred, so it
// is on a second server; its calls must still read as the same Solus tool.
describe('the Codex config for Solus tools', () => {
  test('a tool that always loads is on the direct server only', () => {
    const config = codexSolusServers(access, [tool('list_works'), tool('render_artifact', true)])
    expect(config['mcp_servers.solus']).toMatchObject({ url: access.url, http_headers: { Authorization: 'Bearer t' }, disabled_tools: ['render_artifact'] })
    expect(config['mcp_servers.solus-direct']).toMatchObject({ enabled_tools: ['render_artifact'], omit_tools_from: ['deferred'] })
    expect(Object.keys(codexSolusServers(access, [tool('list_works')]))).toEqual(['mcp_servers.solus'])
  })

  test("a direct call's transcript row names the Solus tool and the item", () => {
    for (const server of ['solus', 'solus-direct']) {
      const row = new CodexTurnNormalizer({ planMode: false }).push({
        method: 'item/started',
        params: { threadId: 'thread-a', turnId: 'turn-1', item: { type: 'mcpToolCall', id: ITEM_ID, server, tool: 'render_artifact', arguments: {}, status: 'inProgress' } },
      }).find((event) => event.type === 'tool_call')
      expect(row).toMatchObject({ type: 'tool_call', toolId: ITEM_ID, toolName: 'solus.render_artifact' })
    }
  })
})

// WHY: a live MCP App card and a tool's own cards follow the call by its
// transcript row's id. Codex names no item on the MCP request, so the run
// matches the call to the item Codex started for it.
describe('the Codex item of a Solus tool call', () => {
  test('a call takes the item Codex started for that tool and those arguments', async () => {
    const run = backendWithRun()
    run.client.emit('notification', { jsonrpc: '2.0', method: 'item/started', params: { threadId: 'thread-a', turnId: 'turn-1', item: { type: 'mcpToolCall', id: 'other', server: 'solus', tool: 'list_works', arguments: { region: 'apac' }, status: 'inProgress' } } })
    run.client.emit('notification', { jsonrpc: '2.0', method: 'item/started', params: { threadId: 'thread-a', turnId: 'turn-1', item: { type: 'mcpToolCall', id: ITEM_ID, server: 'solus', tool: 'list_works', arguments: { region: 'emea' }, status: 'inProgress' } } })
    // A user's own MCP server is not a Solus tool.
    run.client.emit('notification', { jsonrpc: '2.0', method: 'item/started', params: { threadId: 'thread-a', turnId: 'turn-1', item: { type: 'mcpToolCall', id: 'theirs', server: 'linear', tool: 'list_works', arguments: {}, status: 'inProgress' } } })
    expect(await run.handle.solusCalls.claim('list_works', JSON.stringify({ region: 'emea' }))).toBe(ITEM_ID)
    expect(await run.handle.solusCalls.claim('list_works', JSON.stringify({ region: 'other' }))).toBe('other')
    expect(await new SolusCallItems().claim('list_works', '{}')).toBeUndefined()
  })

  test('a call that reaches the endpoint first waits for its item', async () => {
    const calls = new SolusCallItems()
    const claimed = calls.claim('list_works', '{}')
    calls.noteStarted({ item: { type: 'mcpToolCall', id: ITEM_ID, server: 'solus', tool: 'list_works', arguments: {} } })
    expect(await claimed).toBe(ITEM_ID)
  })
})

// WHY: the endpoint asks the person before a Solus tool that needs approval,
// so the person is asked once. Codex's own approval request for a Solus tool
// is accepted; another server's request still reaches the person.
describe('approval of a Solus tool on Codex', () => {
  test("Codex's own request for a Solus server is accepted, another server's is asked", () => {
    const run = backendWithRun()
    run.client.emit('server-request', { jsonrpc: '2.0', id: 7, method: 'mcpServer/elicitation/request', params: { threadId: 'thread-a', turnId: 'turn-1', serverName: 'solus-direct', mode: 'form', message: 'Allow?', requestedSchema: { type: 'object', properties: {} } } })
    expect(run.responses).toEqual([{ action: 'accept', content: {} }])
    run.client.emit('server-request', { jsonrpc: '2.0', id: 8, method: 'mcpServer/elicitation/request', params: { threadId: 'thread-a', turnId: 'turn-1', serverName: 'linear', mode: 'form', message: 'Allow?', requestedSchema: { type: 'object', properties: {} } } })
    expect(run.responses).toHaveLength(1)
    expect(run.events.some((event) => event.type === 'question_request')).toBe(true)
  })

  test('the endpoint asks with a card that names the call, and waits for the answer', async () => {
    const run = backendWithRun()
    const ask = Reflect.get(run.backend, 'askToolApproval') as (handle: object, tool: AgentTool, input: object, toolUseId: string) => Promise<boolean>
    const answer = Reflect.apply(ask, run.backend, [run.handle, tool('update_work'), { work_id: 'w1' }, ITEM_ID])
    const card = run.events.find((event) => event.type === 'permission_request')
    expect(card).toMatchObject({ type: 'permission_request', toolName: 'update_work', toolUseId: ITEM_ID, toolInput: { work_id: 'w1' } })
    expect(run.backend.permissions.respondToPermission(card?.type === 'permission_request' ? card.questionId : '', 'accept')).toBe(true)
    expect(await answer).toBe(true)
  })

  test('full access does not ask', async () => {
    const run = backendWithRun('full-access')
    const ask = Reflect.get(run.backend, 'askToolApproval') as (handle: object, tool: AgentTool, input: object, toolUseId: string) => Promise<boolean>
    expect(await Reflect.apply(ask, run.backend, [run.handle, tool('update_work'), {}, ITEM_ID])).toBe(true)
    expect(run.events).toEqual([])
  })
})
