import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { z } from 'zod'
import { DatabaseSync } from './helpers/bun-sqlite'
import { CodexAppServerClient } from '@solus/server/execution/agents/codex/codex-agent'
import { CodexToolDispatcher, codexDynamicCallId } from '@solus/server/execution/agents/codex/codex-tool-adapter'
import type { AgentTool, AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import type { DynamicToolCallParams } from '@solus/server/execution/agents/codex/generated/v2/DynamicToolCallParams'
import type { NormalizedEvent } from '@solus/contracts/types'

mock.module('node:sqlite', () => ({ DatabaseSync }))

let CodexBackend: typeof import('@solus/server/execution/agents/codex/codex-backend')['CodexBackend']
let CodexTurnNormalizer: typeof import('@solus/server/execution/agents/codex/codex-event-normalizer')['CodexTurnNormalizer']

beforeAll(async () => {
  ;({ CodexBackend } = await import('@solus/server/execution/agents/codex/codex-backend'))
  ;({ CodexTurnNormalizer } = await import('@solus/server/execution/agents/codex/codex-event-normalizer'))
})

// WHY: a live MCP App card follows its call by the transcript row's id, and a
// saved app names the call by the id its tool saw (`parentToolUseId`). For
// Codex the row is the `dynamicToolCall` item and the tool sees the `callId` of
// `item/tool/call`. Codex 0.167 builds both from one core `call_id`. If Solus
// read another id (the JSON-RPC request id), the live card would end as
// `failed` after the call and the saved card would load the app again.

const CALL_ID = 'call_7Hq2'

function context(): AgentToolContext {
  return { provider: 'codex', cwd: '/tmp', sessionId: () => 'thread-a', abortSignal: new AbortController().signal, parentToolUseId: () => undefined, emit: () => undefined }
}

function recordingTool(name: string, requiresApproval: boolean, seen: Array<string | undefined>): AgentTool {
  return {
    name,
    description: 'A chart.',
    inputFields: { region: z.string().optional() },
    requiresApproval,
    execute: async (_input, toolContext) => {
      seen.push(toolContext.parentToolUseId())
      return { ok: true, text: 'drawn' }
    },
  }
}

function backendWith(tools: AgentTool[]) {
  const backend = new CodexBackend()
  const client = new CodexAppServerClient({})
  const responses: unknown[] = []
  client.respond = (_id, result) => { responses.push(result) }
  Reflect.apply(Reflect.get(backend, 'attachClient') as (client: CodexAppServerClient) => void, backend, [client])
  const activeRuns = Reflect.get(backend, 'activeRuns') as Map<string, object>
  activeRuns.set('thread-a', { client, permissionMode: 'supervised', sawPermissionRequest: false, toolDispatcher: new CodexToolDispatcher(tools, context()) })
  const events: NormalizedEvent[] = []
  backend.on('normalized', (_threadId: string, event: NormalizedEvent) => { events.push(event) })
  const call = (tool: string) => {
    const params: DynamicToolCallParams = { threadId: 'thread-a', turnId: 'turn-1', callId: CALL_ID, namespace: 'solus', tool, arguments: { region: 'emea' } }
    client.emit('server-request', { jsonrpc: '2.0', id: 42, method: 'item/tool/call', params })
  }
  return { responses, events, call }
}

describe('the Codex id of a dynamic tool call', () => {
  test('the transcript row, the tool context, and the approval all carry the item id', async () => {
    const row = new CodexTurnNormalizer({ planMode: false }).push({
      method: 'item/started',
      params: { threadId: 'thread-a', turnId: 'turn-1', item: { type: 'dynamicToolCall', id: CALL_ID, namespace: 'solus', tool: 'charts__chart', arguments: {}, status: 'inProgress' } },
    }).find((event) => event.type === 'tool_call')
    expect(row).toMatchObject({ type: 'tool_call', toolId: CALL_ID, toolName: 'solus.charts__chart' })

    const seen: Array<string | undefined> = []
    const run = backendWith([recordingTool('charts__chart', false, seen), recordingTool('charts__save', true, seen)])
    run.call('charts__chart')
    await Bun.sleep(0)
    expect(seen).toEqual([CALL_ID])
    expect(run.responses).toHaveLength(1)

    // A tool that asks first names the same call; before, this path threw before it asked.
    run.call('charts__save')
    expect(run.events.find((event) => event.type === 'permission_request')).toMatchObject({ toolUseId: CALL_ID })
  })

  test('an app server without callId falls back to the request id', () => {
    expect(codexDynamicCallId({ callId: CALL_ID }, 42)).toBe(CALL_ID)
    expect(codexDynamicCallId({}, 42)).toBe('42')
    expect(codexDynamicCallId({ callId: '' }, 'r-1')).toBe('r-1')
  })
})
