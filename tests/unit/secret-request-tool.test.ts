import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { AgentTool, AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import type { NormalizedEvent } from '@solus/contracts/types'
import { SOLUS_TOOL_GROUPS } from '@solus/contracts/agent-tools'
import { adaptClaudeTools } from '@solus/server/execution/agents/claude/claude-tool-adapter'
import { adaptCodexTools } from '@solus/server/execution/agents/codex/codex-tool-adapter'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/webhooks.md §3.6: request_secret is a session facility, not a webhook
// tool. Any tool that needs a credential takes a `secretRef`, so the agent must be
// able to ask for one on every host — also one where the webhook services are not
// bound — and the ref must stay one-use and private to the session that asked.

let toolbox: typeof import('@solus/server/execution/agents/tools/solus-toolbox')['solusToolbox']
let secretRequests: typeof import('@solus/server/execution/sessions/secret-requests')
let webhookTools: typeof import('@solus/server/execution/agents/tools/webhook-tools')
let instructions: typeof import('@solus/server/execution/agents/runtime-instructions')

beforeAll(async () => {
  ;({ solusToolbox: toolbox } = await import('@solus/server/execution/agents/tools/solus-toolbox'))
  secretRequests = await import('@solus/server/execution/sessions/secret-requests')
  webhookTools = await import('@solus/server/execution/agents/tools/webhook-tools')
  instructions = await import('@solus/server/execution/agents/runtime-instructions')
})

function context(sessionId: string, events: NormalizedEvent[]): AgentToolContext {
  return { provider: 'claude-code', cwd: '/tmp', sessionId: () => sessionId, abortSignal: new AbortController().signal, parentToolUseId: () => undefined, emit: (event) => { events.push(event) } }
}

/** The tools a prompted run gets from the session group. */
function sessionTools(): AgentTool[] {
  return Object.values(toolbox.sessions)
}

describe('request_secret as a session tool', () => {
  test('it is a Sessions tool, offered to Claude and Codex while no webhook services are bound', async () => {
    webhookTools.setWebhookToolServices(null)
    expect(SOLUS_TOOL_GROUPS.find((group) => group.id === 'sessions')?.tools).toContain('request_secret')
    expect(SOLUS_TOOL_GROUPS.find((group) => group.id === 'webhooks')?.tools).not.toContain('request_secret')

    const { server } = adaptClaudeTools(sessionTools(), context('s', []), 'default')
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
    await server.instance.connect(serverSide)
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(clientSide)
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('request_secret')
    await client.close()

    expect(adaptCodexTools(sessionTools())[0]?.tools.map((tool) => tool.name)).toContain('request_secret')
  })

  test('its description names no webhook; it and the shared guidance keep the never-ask-in-chat rule', () => {
    // WHY: without these sentences a model tells the person to paste the secret into the
    // conversation, or promises a private prompt it never opens. A later edit must not drop them.
    const description = toolbox.sessions.requestSecret.description
    expect(description).not.toMatch(/webhook/i)
    expect(description).toContain('never ask the person to type a secret into the conversation')
    expect(description.endsWith('Asked how to provide a secret: call this now, do not explain instead.')).toBe(true)
    const text = instructions.runtimeInstructions({ harness: 'Codex', model: 'm', reasoningEffort: 'low' }, sessionTools())
    expect(text).toContain('A secret: call `request_secret` yourself and pass its `secretRef` to the tool that needs it. Never ask for a secret in chat and never invent one.')
  })

  test('the result names the outcome: saved with its ref, or declined, or cancelled', async () => {
    const events: NormalizedEvent[] = []
    const declined = toolbox.sessions.requestSecret.execute({ name: 'x', reason: 'y' }, context('session-a', events))
    await Promise.resolve()
    const card = events[0]
    secretRequests.answerSecretRequest('session-a', card.type === 'question_request' ? card.questionId : '', null)
    expect(JSON.parse((await declined).text)).toEqual({ status: 'declined' })
    const abort = new AbortController()
    const cancelled = toolbox.sessions.requestSecret.execute({ name: 'x', reason: 'y' }, { ...context('session-a', []), abortSignal: abort.signal })
    abort.abort()
    expect(JSON.parse((await cancelled).text)).toEqual({ status: 'cancelled' })
  })

  test('a secretRef works once, and only in the session that asked', async () => {
    const events: NormalizedEvent[] = []
    const asking = toolbox.sessions.requestSecret.execute({ name: 'Stripe key', reason: 'To call the API.' }, context('session-a', events))
    await Promise.resolve()
    const card = events.find((event) => event.type === 'question_request')
    const questionId = card?.type === 'question_request' ? card.questionId : ''
    expect(secretRequests.answerSecretRequest('session-a', questionId, 'sk_live_x')).toBe(true)
    const answer = await asking
    expect(answer.text).not.toContain('sk_live_x')
    const outcome = JSON.parse(answer.text) as { status: string; secretRef: string }
    expect(outcome.status).toBe('saved')
    const ref = outcome.secretRef
    expect(secretRequests.takeSecretRef(ref, 'session-b')).toBeNull()
    expect(secretRequests.takeSecretRef(ref, 'session-a')).toBe('sk_live_x')
    expect(secretRequests.takeSecretRef(ref, 'session-a')).toBeNull()
  })
})
