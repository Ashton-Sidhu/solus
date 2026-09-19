import { describe, expect, mock, test } from 'bun:test'
import { z } from 'zod'
import { createJevAgentTool } from '../../packages/server/src/typesafe/jev-tool'
import { createTypeSafe } from '../../packages/server/src/typesafe/index'
import { executeAgentTool, type AgentToolContext } from '../../packages/server/src/agents/tools/agent-tool'
import { adaptCodexTools, CodexToolDispatcher } from '../../packages/server/src/agents/codex/codex-tool-adapter'
import { adaptClaudeTools } from '../../packages/server/src/agents/claude/claude-tool-adapter'
import { solusAgentToolName } from '../../packages/contracts/src/agent-tools'

const context: AgentToolContext = {
  provider: 'codex', cwd: '/repo', sessionId: () => 'provider-session',
  solusSessionId: () => 'solus-session', parentToolUseId: () => undefined,
  abortSignal: new AbortController().signal, emit: () => {},
}
const input = {
  state: '{"request":"Find the retry policy","candidates":["transport.ts","theme.ts"]}',
  questions: [
    { id: 'file', type: 'choice', instructions: 'Which candidate concerns retries?', options: [
      { label: 'transport', description: 'HTTP retry transport.' },
      { label: 'none', description: 'No relevant candidate.' },
    ] },
    { id: 'relevant', type: 'noul', instructions: 'Is there a relevant candidate?' },
    { id: 'fit', type: 'score', instructions: 'How relevant is transport.ts?', levels: ['Unrelated', 'Directly relevant'] },
  ],
  model: 'jev-test',
}
const reply = {
  model: 'jev-test', usage: { input_tokens: 100, output_tokens: 30 },
  answers: {
    file: { type: 'choice', choice: 'transport', probabilities: { transport: 0.9, none: 0.1 }, confidence: 0.8 },
    relevant: { type: 'noul', noul: 0.9 },
    fit: { type: 'score', score: 0.9, probabilities: { 0: 0.1, 1: 0.9 }, confidence: 0.8, legend: { 0: 'Unrelated', 1: 'Directly relevant' } },
  },
}

describe('ask_jev', () => {
  test('both providers can discover it and clients recognize both names', () => {
    const tool = createJevAgentTool()
    const codex = adaptCodexTools([tool])[0]
    expect(codex.name).toBe('ask_jev')
    expect(JSON.stringify(codex.inputSchema)).toBe(JSON.stringify(z.toJSONSchema(z.object(tool.inputFields))))
    const claude = adaptClaudeTools([tool], { ...context, provider: 'claude-code' }, 'plan')
    expect(claude.allowedTools).toEqual(['mcp__solus__ask_jev'])
    expect(tool.alwaysLoad).toBe(true)
    expect(solusAgentToolName('ask_jev')).toBe('ask_jev')
    expect(solusAgentToolName('mcp__solus__ask_jev')).toBe('ask_jev')
  })

  test('one batch preserves question IDs, evidence, model, probabilities, and measurement data', async () => {
    let calls = 0
    const client = createTypeSafe({ apiKey: 'test-key', fetch: async (url, init) => {
      calls++
      expect(init?.signal).toBeDefined()
      expect(await new Request(url, init).json()).toEqual({
        state: input.state, model: 'jev-test', questions: {
          file: { type: 'choice', instructions: input.questions[0].instructions, criteria: { transport: 'HTTP retry transport.', none: 'No relevant candidate.' } },
          relevant: { type: 'noul', instructions: input.questions[1].instructions },
          fit: { type: 'score', instructions: input.questions[2].instructions, criteria: ['Unrelated', 'Directly relevant'] },
        },
      })
      return Response.json(reply, { headers: { 'x-typesafe-request-id': 'jev-request-1' } })
    } })
    const dispatcher = new CodexToolDispatcher([createJevAgentTool(() => client)], context)
    const result = await dispatcher.execute('ask_jev', input)
    expect(result.ok).toBe(true)
    expect(JSON.parse(result.text)).toEqual({ ...reply, request_id: 'jev-request-1', elapsed_ms: expect.any(Number) })
    expect(calls).toBe(1)
  })

  test('rejects invalid or ambiguous batches before creating a client', async () => {
    let calls = 0
    const tool = createJevAgentTool(() => { calls++; throw new Error('Unexpected client creation') })
    const invalidInputs = [
      { state: ' ', questions: input.questions },
      { state: 'Evidence', questions: [] },
      { ...input, questions: [input.questions[0], input.questions[0]] },
      { ...input, questions: [{ ...input.questions[0], options: [{ label: 'same', description: 'A' }, { label: 'same', description: 'B' }] }] },
      { ...input, questions: [{ id: 'score', type: 'score', instructions: 'Rate it', levels: ['Only one level'] }] },
      { ...input, questions: [{ id: 'q', type: 'generate', instructions: 'Write code' }] },
      { ...input, state: 'x'.repeat(100_001) },
      { ...input, questions: Array.from({ length: 40 }, (_, i) => ({ id: `q${i}`, type: 'noul', instructions: 'x'.repeat(4_000) })) },
    ]
    for (const invalid of invalidInputs) expect((await executeAgentTool(tool, invalid, context)).ok).toBe(false)
    expect(calls).toBe(0)
  })

  test('cancellation and missing configuration produce terminal failures without network calls', async () => {
    let calls = 0
    const tool = createJevAgentTool(() => { calls++; return createTypeSafe({ apiKey: '' }) })
    const cancelled = await executeAgentTool(tool, input, { ...context, abortSignal: AbortSignal.abort() })
    expect(cancelled).toEqual({ ok: false, text: 'Jev request cancelled.' })
    expect(calls).toBe(0)
    const unavailable = await executeAgentTool(tool, input, context)
    expect(unavailable.ok).toBe(false)
    expect(unavailable.text).toContain('TYPESAFE_API_KEY')
    expect(unavailable.text).toContain('normal process')
  })

  test('does not expose an upstream error body as evidence or leak it in the result', async () => {
    const client = createTypeSafe({ apiKey: 'test-key', fetch: async () => Response.json(
      { error: 'SECRET copied from request state' }, { status: 401 },
    ) })
    const result = await executeAgentTool(createJevAgentTool(() => client), input, context)
    expect(result.ok).toBe(false)
    expect(result.text).toContain('401')
    expect(result.text).not.toContain('SECRET')
  })

  test('stopping a turn cancels an in-flight Jev request', async () => {
    const started = Promise.withResolvers<void>()
    const controller = new AbortController()
    let calls = 0
    const client = createTypeSafe({ apiKey: 'test-key', fetch: async (_url, init) => {
      calls++
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('Aborted transport')), { once: true })
        started.resolve()
      })
    } })
    const pending = executeAgentTool(createJevAgentTool(() => client), input, {
      ...context, provider: 'claude-code', abortSignal: controller.signal,
    })
    await started.promise
    controller.abort()
    expect(await pending).toEqual({ ok: false, text: 'Jev request cancelled.' })
    expect(calls).toBe(1)
  })
})

// These tests exercise the SDK transport with synthetic keys. Credential gating
// has separate tests against an isolated host secret store.
mock.module('../../packages/server/src/typesafe/credentials', () => ({
  typeSafeApiKey: () => 'test-key',
  typeSafeKeyStatus: () => ({ source: 'environment' }),
}))
