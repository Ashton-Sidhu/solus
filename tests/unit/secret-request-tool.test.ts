import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { AgentTool, AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import type { NormalizedEvent } from '@solus/contracts/types'
import { SOLUS_TOOL_GROUPS } from '@solus/contracts/agent-tools'
import { adaptClaudeTools } from '@solus/server/execution/agents/claude/claude-tool-adapter'
import { adaptCodexTools } from '@solus/server/execution/agents/codex/codex-tool-adapter'
import { SECRET_FILE_TTL_MS } from '@solus/contracts/agent-tools'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { actAsHostForTests, hostSecretFilesFolder } from '@solus/server/execution/seats/acting-identity'

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
  actAsHostForTests()
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
    expect(text).toContain('A secret: call `request_secret` yourself and pass its `secretRef` to the tool that needs it, or use `delivery: "file"` for a shell command and read the file inside the command. Never ask for a secret in chat and never invent one.')
  })

  test('the result names the outcome: saved with its ref, or declined, or cancelled', async () => {
    const events: NormalizedEvent[] = []
    const declined = toolbox.sessions.requestSecret.execute({ secrets: [{ name: 'x', reason: 'y' }] }, context('session-a', events))
    await Promise.resolve()
    const card = events[0]
    secretRequests.answerSecretRequest('session-a', card.type === 'question_request' ? card.questionId : '', [null])
    expect(JSON.parse((await declined).text)).toEqual({ secrets: [{ name: 'x', status: 'declined' }] })
    const abort = new AbortController()
    const cancelled = toolbox.sessions.requestSecret.execute({ secrets: [{ name: 'x', reason: 'y' }] }, { ...context('session-a', []), abortSignal: abort.signal })
    abort.abort()
    expect(JSON.parse((await cancelled).text)).toEqual({ status: 'cancelled' })
  })

  test('a secretRef works once, and only in the session that asked', async () => {
    const events: NormalizedEvent[] = []
    const asking = toolbox.sessions.requestSecret.execute({ secrets: [{ name: 'Stripe key', reason: 'To call the API.' }] }, context('session-a', events))
    await Promise.resolve()
    const card = events.find((event) => event.type === 'question_request')
    const questionId = card?.type === 'question_request' ? card.questionId : ''
    expect(secretRequests.answerSecretRequest('session-a', questionId, ['sk_live_x'])).toBe(true)
    const answer = await asking
    expect(answer.text).not.toContain('sk_live_x')
    const [outcome] = (JSON.parse(answer.text) as { secrets: { status: string; secretRef: string }[] }).secrets
    expect(outcome.status).toBe('saved')
    const ref = outcome.secretRef
    expect(secretRequests.takeSecretRef(ref, 'session-b')).toBeNull()
    expect(secretRequests.takeSecretRef(ref, 'session-a')).toBe('sk_live_x')
    expect(secretRequests.takeSecretRef(ref, 'session-a')).toBeNull()
  })

  test('one card asks for many secrets; a declined one gives no ref and the others still save', async () => {
    // WHY: a task often needs several credentials. The person may hold some and not
    // others, so declining one secret must not throw away the ones they typed.
    const events: NormalizedEvent[] = []
    const asking = toolbox.sessions.requestSecret.execute({ secrets: [
      { name: 'Stripe key', reason: 'To call the API.' },
      { name: 'Slack token', reason: 'To post updates.' },
      { name: 'Sentry DSN', reason: 'To report errors.' },
    ] }, context('session-a', events))
    await Promise.resolve()
    const cards = events.filter((event) => event.type === 'question_request')
    expect(cards).toHaveLength(1)
    const card = cards[0]
    if (card.type !== 'question_request') throw new Error('no card')
    expect(card.questions.map((question) => question.header)).toEqual(['Stripe key', 'Slack token', 'Sentry DSN'])
    // An answer that does not fit the card is refused, and the card stays open.
    expect(secretRequests.answerSecretRequest('session-a', card.questionId, ['sk_live_x', null])).toBe(false)
    expect(secretRequests.answerSecretRequest('session-a', card.questionId, ['sk_live_x', '', null])).toBe(false)
    expect(secretRequests.answerSecretRequest('session-a', card.questionId, ['sk_live_x', null, 'https://dsn'])).toBe(true)
    const answer = await asking
    expect(answer.text).not.toContain('sk_live_x')
    const { secrets } = JSON.parse(answer.text) as { secrets: { name: string; status: string; secretRef?: string }[] }
    expect(secrets.map(({ name, status }) => ({ name, status }))).toEqual([
      { name: 'Stripe key', status: 'saved' },
      { name: 'Slack token', status: 'declined' },
      { name: 'Sentry DSN', status: 'saved' },
    ])
    expect(secrets[1].secretRef).toBeUndefined()
    expect(secretRequests.takeSecretRef(secrets[0].secretRef!, 'session-a')).toBe('sk_live_x')
    expect(secretRequests.takeSecretRef(secrets[2].secretRef!, 'session-a')).toBe('https://dsn')
  })

  test('a file secret goes to a private file the agent\'s commands read; the agent gets only the path', async () => {
    // WHY: a CLI token cannot take a secretRef. The agent's shell needs the value, but the
    // transcript and the tool result must still never hold it, and no other user may read it.
    const events: NormalizedEvent[] = []
    const asking = toolbox.sessions.requestSecret.execute({ secrets: [
      { name: 'Cloudflare token', reason: 'For wrangler.', delivery: 'file' },
      { name: 'Webhook secret', reason: 'To verify.' },
    ] }, context('session-a', events))
    await Promise.resolve()
    const card = events.find((event) => event.type === 'question_request')
    if (card?.type !== 'question_request') throw new Error('no card')
    // The card tells every client which secret the commands can read.
    expect(card.questions.map((question) => question.secretDelivery)).toEqual(['file', undefined])
    expect(secretRequests.answerSecretRequest('session-a', card.questionId, ['cf_token_x', 'whsec_x'])).toBe(true)
    const answer = await asking
    expect(answer.text).not.toContain('cf_token_x')
    const [file, ref] = (JSON.parse(answer.text) as { secrets: { status: string; path?: string; secretRef?: string }[] }).secrets
    expect(file.secretRef).toBeUndefined()
    expect(file.path!.startsWith(hostSecretFilesFolder())).toBe(true)
    expect(readFileSync(file.path!, 'utf8')).toBe('cf_token_x')
    expect(statSync(file.path!).mode & 0o777).toBe(0o600)
    expect(statSync(hostSecretFilesFolder()).mode & 0o777).toBe(0o700)
    expect(secretRequests.takeSecretRef(ref.secretRef!, 'session-a')).toBe('whsec_x')

    // The file stays for the task and goes when its time is over.
    secretRequests.removeExpiredSecretFiles(Date.now() + SECRET_FILE_TTL_MS - 60_000)
    expect(existsSync(file.path!)).toBe(true)
    secretRequests.removeExpiredSecretFiles(Date.now() + SECRET_FILE_TTL_MS + 1)
    expect(existsSync(file.path!)).toBe(false)
  })

  test('a url must be http(s); a good one reaches the card', async () => {
    // WHY: the card opens the url, so the agent must not be able to make it open another scheme.
    const { executeAgentTool } = await import('@solus/server/execution/agents/tools/agent-tool')
    const refused = await executeAgentTool(toolbox.sessions.requestSecret, { secrets: [{ name: 'x', reason: 'y', url: 'javascript:alert(1)' }] }, context('session-a', []))
    expect(refused.ok).toBe(false)
    expect(refused.text).toContain('url must be an http or https link.')

    const events: NormalizedEvent[] = []
    const asking = toolbox.sessions.requestSecret.execute({ secrets: [{ name: 'GitHub code', reason: 'Enter the code.', url: 'https://github.com/login/device' }] }, context('session-a', events))
    await Promise.resolve()
    const card = events.find((event) => event.type === 'question_request')
    if (card?.type !== 'question_request') throw new Error('no card')
    expect(card.questions[0].secretUrl).toBe('https://github.com/login/device')
    secretRequests.answerSecretRequest('session-a', card.questionId, [null])
    await asking
  })
})
