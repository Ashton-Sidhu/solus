import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { DatabaseSync } from '../helpers/bun-sqlite'
import type { Integration } from '@solus/contracts/integration-types'
import type { NormalizedEvent } from '@solus/contracts/types'
import type { AgentToolContext, AgentToolResult } from '@solus/server/execution/agents/tools/agent-tool'
import type { CallClock } from '@solus/server/integrations/call-progress'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const { IntegrationGateway } = await import('@solus/server/integrations/gateway')
const { CallLimits, ProgressEvents } = await import('@solus/server/integrations/call-progress')
const { upstreamToolToAgentTool } = await import('@solus/server/integrations/integration-tools')
const { withActingScope } = await import('@solus/server/vault/acting-scope')
const { HOST_SCOPE } = await import('@solus/server/execution/seats/acting-identity')
const { adaptClaudeTools } = await import('@solus/server/execution/agents/claude/claude-tool-adapter')
const { CodexToolDispatcher } = await import('@solus/server/execution/agents/codex/codex-tool-adapter')
const { SessionEmitter } = await import('@solus/server/execution/observability/session-emitter')
const { getMetricsDb } = await import('@solus/server/data/insights/metrics-db')

/**
 * Progress, the two call limits, and trace context of an upstream tool call
 * (docs/plans/mcp-first-class.md §5 and §13), against a real streamable HTTP
 * MCP server. The limits run on a fake clock; only the network is real.
 */

type ServerStep = { kind: 'progress'; progress: number; total?: number; message?: string } | { kind: 'finish' }

/** The `long` tool waits for the test: each step sends one progress notification or ends the call. */
let nextStep: ((step: ServerStep) => void) | undefined
/** The `_meta` of every `tools/call` the server received. */
const seenMeta: Array<Record<string, unknown> | undefined> = []
let httpServer: Server
let integration: Integration

function makeServer(): McpServer {
  const server = new McpServer({ name: 'progress-fake', version: '1.0.0' })
  server.registerTool('long', { description: 'Run until the test ends it.' }, async (extra) => {
    seenMeta.push(extra._meta)
    const token = extra._meta?.progressToken
    for (;;) {
      const step = await new Promise<ServerStep>((resolve) => { nextStep = resolve })
      if (step.kind === 'finish') return { content: [{ type: 'text', text: 'done' }] }
      if (token === undefined) continue
      await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: step.progress, total: step.total, message: step.message } })
    }
  })
  server.registerTool('quick', { description: 'Report once, then answer.' }, async (extra) => {
    seenMeta.push(extra._meta)
    const token = extra._meta?.progressToken
    if (token !== undefined) await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: 1, total: 2, message: 'Halfway' } })
    return { content: [{ type: 'text', text: 'quick done' }] }
  })
  return server
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
}

beforeAll(async () => {
  httpServer = createServer(async (req, res) => {
    const parsed = req.method === 'POST' ? await body(req) : undefined
    const server = makeServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    await server.connect(transport)
    res.on('close', () => { void transport.close(); void server.close() })
    await transport.handleRequest(req, res, parsed)
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const { port } = httpServer.address() as AddressInfo
  integration = {
    id: 'int-progress', organizationId: 'local', ownerKey: 'local:test', kind: 'mcp', slug: 'fake', name: 'Fake',
    url: `http://127.0.0.1:${port}/mcp`, auth: { kind: 'none' }, disabledTools: [],
    createdAt: '2026-11-19T00:00:00Z', updatedAt: '2026-11-19T00:00:00Z',
  }
})

afterAll(async () => {
  nextStep?.({ kind: 'finish' })
  httpServer.closeAllConnections()
  await new Promise<void>((resolve) => httpServer.close(() => resolve()))
})

/** Timers that run only when the test moves the time, in deadline order. */
function fakeClock() {
  let now = 0
  let nextId = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  return {
    timers,
    now: () => now,
    setTimeout: (run: () => void, delay: number) => { const id = ++nextId; timers.set(id, { at: now + delay, run }); return id },
    clearTimeout: (id: number) => { timers.delete(id) },
    advance(milliseconds: number) {
      const end = now + milliseconds
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].run()
      }
      now = end
    },
  }
}

function asCallClock(clock: ReturnType<typeof fakeClock>): CallClock {
  // SAFETY: the fake takes the same arguments; its ids are numbers instead of Node's timer objects.
  return clock as unknown as CallClock
}

function context(events: NormalizedEvent[]): AgentToolContext {
  return {
    provider: 'claude-code', cwd: '/tmp', sessionId: () => 'session-1', abortSignal: new AbortController().signal,
    parentToolUseId: () => 'toolu_card', emit: (event) => events.push(event),
  }
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out')
}

/** Hands the waiting server one step, then waits until the gateway heard its progress. */
async function serverStep(step: ServerStep, events: NormalizedEvent[]): Promise<void> {
  const send = await waitFor(() => nextStep)
  nextStep = undefined
  const heard = events.length
  send(step)
  if (step.kind === 'progress') await waitFor(() => (events.length > heard ? true : undefined))
}

function progressEvents(events: NormalizedEvent[]): Array<Extract<NormalizedEvent, { type: 'tool_progress' }>> {
  return events.filter((event): event is Extract<NormalizedEvent, { type: 'tool_progress' }> => event.type === 'tool_progress')
}

function started(call: Promise<AgentToolResult>): { result: () => AgentToolResult | undefined } {
  let settled: AgentToolResult | undefined
  void call.then((value) => { settled = value })
  return { result: () => settled }
}

describe('the call limits', () => {
  test('a call that reports progress every 30 seconds for three minutes ends well', async () => {
    const clock = fakeClock()
    const gateway = new IntegrationGateway({ get: () => integration, list: () => [integration] }, asCallClock(clock))
    const events: NormalizedEvent[] = []
    try {
      const call = withActingScope(HOST_SCOPE, () => gateway.call(integration.id, 'long', {}, context(events)))
      for (let step = 1; step <= 6; step++) {
        await waitFor(() => nextStep)
        clock.advance(30_000)
        await serverStep({ kind: 'progress', progress: step, total: 6, message: `Step ${step}` }, events)
      }
      await serverStep({ kind: 'finish' }, events)
      expect(await call).toEqual({ ok: true, text: 'done' })
      expect(progressEvents(events).map((event) => event.progress)).toEqual([1, 2, 3, 4, 5, 6])
      expect(progressEvents(events)[5]).toEqual({ type: 'tool_progress', toolUseId: 'toolu_card', progress: 6, total: 6, message: 'Step 6' })
      // The call ended: no limit and no progress window is left running.
      expect(clock.timers.size).toBe(0)
    } finally { await gateway.close() }
  })

  test('a silent call stops at the silence limit with the message it had before', async () => {
    const clock = fakeClock()
    const gateway = new IntegrationGateway({ get: () => integration, list: () => [integration] }, asCallClock(clock))
    try {
      const call = started(withActingScope(HOST_SCOPE, () => gateway.call(integration.id, 'long', {}, context([]))))
      await waitFor(() => nextStep)
      clock.advance(59_999)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(call.result()).toBeUndefined()
      clock.advance(1)
      expect(await waitFor(call.result)).toEqual({ ok: false, text: 'Fake did not answer within 60 seconds.' })
    } finally { nextStep = undefined; await gateway.close() }
  })

  test('a progress notification starts the silence limit again', async () => {
    const clock = fakeClock()
    const gateway = new IntegrationGateway({ get: () => integration, list: () => [integration] }, asCallClock(clock))
    const events: NormalizedEvent[] = []
    try {
      const call = started(withActingScope(HOST_SCOPE, () => gateway.call(integration.id, 'long', {}, context(events))))
      await waitFor(() => nextStep)
      clock.advance(50_000)
      await serverStep({ kind: 'progress', progress: 1 }, events)
      // 100 seconds since the call started, 50 since it last spoke.
      clock.advance(50_000)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(call.result()).toBeUndefined()
      clock.advance(10_000)
      expect(await waitFor(call.result)).toEqual({ ok: false, text: 'Fake did not answer within 60 seconds.' })
    } finally { nextStep = undefined; await gateway.close() }
  })

  test('the total limit stops a call that never stops reporting progress', async () => {
    const clock = fakeClock()
    const gateway = new IntegrationGateway({ get: () => integration, list: () => [integration] }, asCallClock(clock))
    const events: NormalizedEvent[] = []
    try {
      const call = started(withActingScope(HOST_SCOPE, () => gateway.call(integration.id, 'long', {}, context(events))))
      // A notification each 50 seconds never lets the silence limit fire.
      for (let step = 1; step < 36; step++) {
        await waitFor(() => nextStep)
        clock.advance(50_000)
        await serverStep({ kind: 'progress', progress: step }, events)
        expect(call.result()).toBeUndefined()
      }
      clock.advance(50_000)
      expect(await waitFor(call.result)).toEqual({ ok: false, text: 'Fake did not finish long within 30 minutes, so Solus stopped the call.' })
      expect(progressEvents(events)).toHaveLength(35)
    } finally { nextStep = undefined; await gateway.close() }
  })
})

describe('a question of the server', () => {
  test('stops both limits, and the total limit keeps the time it already used', () => {
    const clock = fakeClock()
    const reached: string[] = []
    const limits = new CallLimits(asCallClock(clock), (limit) => reached.push(limit))
    limits.start()
    for (let minute = 0; minute < 20; minute++) { clock.advance(50_000); limits.progressed() }
    // The person takes an hour to answer: no limit runs meanwhile.
    limits.pause()
    expect(clock.timers.size).toBe(0)
    clock.advance(60 * 60_000)
    limits.start()
    for (let step = 0; step < 15; step++) { clock.advance(50_000); limits.progressed() }
    expect(reached).toEqual([])
    // 1,000 s before the question and 750 s after it: 50 s more reach 30 minutes.
    clock.advance(50_000)
    expect(reached).toEqual(['total'])
  })
})

describe('progress events', () => {
  test('twenty notifications in one second give at most four events, and the newest is not lost', () => {
    const clock = fakeClock()
    const events: NormalizedEvent[] = []
    const progress = new ProgressEvents(asCallClock(clock), context(events))
    for (let step = 1; step <= 20; step++) {
      progress.report({ progress: step, total: 20 })
      if (step < 20) clock.advance(50)
    }
    // 950 ms of notifications: sent at 0, 250, 500, and 750 ms, each the newest that had arrived.
    expect(progressEvents(events).map((event) => event.progress)).toEqual([1, 5, 10, 15])
    clock.advance(250)
    expect(progressEvents(events).at(-1)?.progress).toBe(20)
    clock.advance(1_000)
    expect(progressEvents(events)).toHaveLength(5)
    expect(clock.timers.size).toBe(0)
  })

  test('a message is one line of plain text, cut at 200 characters', () => {
    const clock = fakeClock()
    const events: NormalizedEvent[] = []
    new ProgressEvents(asCallClock(clock), context(events)).report({ progress: 1, message: `Copying\n  ${'x'.repeat(300)}` })
    const [event] = progressEvents(events)
    expect(event?.message).toBe(`Copying ${'x'.repeat(192)}`)
    expect(event?.total).toBeUndefined()
  })

  test('the end of a call drops a waiting event, so none follows the result', () => {
    const clock = fakeClock()
    const events: NormalizedEvent[] = []
    const progress = new ProgressEvents(asCallClock(clock), context(events))
    progress.report({ progress: 1 })
    progress.report({ progress: 2 })
    progress.end()
    clock.advance(1_000)
    expect(progressEvents(events).map((event) => event.progress)).toEqual([1])
  })

  test('a call with no card id sends no event, because no client could place it', () => {
    const events: NormalizedEvent[] = []
    new ProgressEvents(asCallClock(fakeClock()), { ...context(events), parentToolUseId: () => undefined }).report({ progress: 1 })
    expect(events).toEqual([])
  })
})

describe('the card a progress event names', () => {
  const upstream = { name: 'quick', inputSchema: { type: 'object' as const } }

  test('Claude: the tool-use id the CLI stamps on the call', async () => {
    const gateway = new IntegrationGateway({ get: () => integration, list: () => [integration] })
    const events: NormalizedEvent[] = []
    try {
      const { server } = adaptClaudeTools([upstreamToolToAgentTool(integration, upstream, gateway)], { ...context(events), parentToolUseId: () => undefined }, 'auto')
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
      await server.instance.connect(serverSide)
      const client = new Client({ name: 'claude-cli', version: '1.0.0' })
      await client.connect(clientSide)
      const result = await withActingScope(HOST_SCOPE, () => client.callTool({ name: 'fake__quick', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_from_cli' } }))
      expect(result.content).toEqual([{ type: 'text', text: 'quick done' }])
      expect(progressEvents(events)).toEqual([{ type: 'tool_progress', toolUseId: 'toolu_from_cli', progress: 1, total: 2, message: 'Halfway' }])
      await client.close()
    } finally { await gateway.close() }
  })

  test('Codex: the call id of the dynamic tool call, which is its item id', async () => {
    const gateway = new IntegrationGateway({ get: () => integration, list: () => [integration] })
    const events: NormalizedEvent[] = []
    try {
      const dispatcher = new CodexToolDispatcher([upstreamToolToAgentTool(integration, upstream, gateway)], { ...context(events), provider: 'codex', parentToolUseId: () => undefined })
      const result = await withActingScope(HOST_SCOPE, () => dispatcher.execute('solus.fake__quick', {}, 'call_from_codex'))
      expect(result).toEqual({ ok: true, text: 'quick done' })
      expect(progressEvents(events)).toEqual([{ type: 'tool_progress', toolUseId: 'call_from_codex', progress: 1, total: 2, message: 'Halfway' }])
    } finally { await gateway.close() }
  })
})

describe('trace context', () => {
  test('a call of a turn sends the traceparent of its integration_call span, and never baggage', async () => {
    const emitter = new SessionEmitter()
    const turnTraceId = emitter.beginTurn({ sessionId: 'session-1', prompt: 'read it', promptSource: 'typed', startedAt: Date.now() })
    const gateway = new IntegrationGateway({ get: () => integration, list: () => [integration] })
    gateway.useTurnContext((sessionId, toolUseId) => emitter.turnContextOf(sessionId, toolUseId))
    try {
      seenMeta.length = 0
      expect(await withActingScope(HOST_SCOPE, () => gateway.call(integration.id, 'quick', {}, context([])))).toEqual({ ok: true, text: 'quick done' })
      const meta = seenMeta.at(-1)
      const traceparent = String(meta?.traceparent)
      const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/.exec(traceparent)
      expect(match?.[1]).toBe(turnTraceId)
      expect(meta).not.toHaveProperty('baggage')
      expect(meta).not.toHaveProperty('tracestate')
      const spans = getMetricsDb().prepare("SELECT span_id, trace_id, parent_span_id, session_id, status, attrs FROM spans WHERE kind = 'integration_call'").all() as Array<{ span_id: string; trace_id: string; parent_span_id: string; session_id: string; status: string; attrs: string }>
      expect(spans).toHaveLength(1)
      const [span] = spans
      expect(span?.span_id).toBe(match?.[2])
      expect(span?.trace_id).toBe(turnTraceId)
      // The tool call has no open span of its own here, so the turn's root is the parent; the table names a root by its trace.
      expect(span?.parent_span_id).toBe(turnTraceId)
      expect(span?.session_id).toBe('session-1')
      expect(span?.status).toBe('ok')
      expect(JSON.parse(span?.attrs ?? '{}')).toMatchObject({ 'mcp.method.name': 'tools/call', 'gen_ai.tool.name': 'quick', integration: 'fake' })
    } finally { await gateway.close() }
  })

  test('a call outside a turn sends no trace context', async () => {
    const emitter = new SessionEmitter()
    const gateway = new IntegrationGateway({ get: () => integration, list: () => [integration] })
    gateway.useTurnContext((sessionId, toolUseId) => emitter.turnContextOf(sessionId, toolUseId))
    try {
      seenMeta.length = 0
      await withActingScope(HOST_SCOPE, () => gateway.call(integration.id, 'quick', {}, context([])))
      expect(seenMeta.at(-1)).not.toHaveProperty('traceparent')
      expect(seenMeta.at(-1)).not.toHaveProperty('baggage')
    } finally { await gateway.close() }
  })
})
