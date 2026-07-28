import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

/** Raw provider messages the mocked SDK replays for the turn-lifetime tests.
 *  Only `query` is stubbed — the rest of the SDK (notably `tool`) is still
 *  needed by the MCP servers the backend builds. */
let scriptedMessages: unknown[] = []
const realSdk = await import('@anthropic-ai/claude-agent-sdk')
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: () => (async function* () {
    for (const msg of scriptedMessages) yield msg
  })(),
}))

let ClaudeBackend: typeof import('../../src/main/agents/claude/claude-backend')['ClaudeBackend']
let ClaudeAgent: typeof import('../../src/main/agents/claude/claude-agent')['ClaudeAgent']
let TurnInputChannel: typeof import('../../src/main/agents/claude/claude-turn-input')['TurnInputChannel']
beforeAll(async () => {
  ;({ ClaudeBackend } = await import('../../src/main/agents/claude/claude-backend'))
  ;({ ClaudeAgent } = await import('../../src/main/agents/claude/claude-agent'))
  ;({ TurnInputChannel } = await import('../../src/main/agents/claude/claude-turn-input'))
})

const opening = (text: string): SDKUserMessage =>
  ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }) as SDKUserMessage

function activeRun(backend: unknown, sessionId: string) {
  const input = new TurnInputChannel(opening('Refactor the parser'), 'Refactor the parser')
  ;(backend as { activeRuns: Map<string, unknown> }).activeRuns.set(sessionId, { input })
  return input
}

describe('ClaudeBackend steering', () => {
  test('delivers into the turn that is already running, not the next one', async () => {
    const backend = new ClaudeBackend()
    const input = activeRun(backend, 'session-1')

    // Drain the opening message so the agent loop is parked on the open stream,
    // exactly as it is mid-turn while the model works.
    const reader = input.stream[Symbol.asyncIterator]()
    await reader.next()
    const midTurn = reader.next()

    await expect(backend.steerSession('session-1', { prompt: 'Use the visitor pattern instead' }))
      .resolves.toBeTruthy()

    const delivered = await midTurn
    expect(delivered.done).toBe(false)
    expect(delivered.value?.message.content).toBe('Use the visitor pattern instead')
    expect(delivered.value?.priority).toBe('now')
  })

  test('carries image attachments as content blocks', async () => {
    const backend = new ClaudeBackend()
    const input = activeRun(backend, 'session-1')
    const reader = input.stream[Symbol.asyncIterator]()
    await reader.next()
    const midTurn = reader.next()

    await backend.steerSession('session-1', {
      prompt: 'Match this mockup',
      imageAttachments: [{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,aW1hZ2U=' }],
    })

    expect((await midTurn).value?.message.content).toEqual([
      { type: 'text', text: 'Match this mockup' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
    ])
  })

  test('declines once the turn has settled so the prompt is queued, not dropped', async () => {
    const backend = new ClaudeBackend()
    const input = activeRun(backend, 'session-1')
    input.close()

    await expect(backend.steerSession('session-1', { prompt: 'Follow up' }))
      .resolves.toBeNull()
  })

  test('declines when no run is active for the session', async () => {
    const backend = new ClaudeBackend()
    await expect(backend.steerSession('session-unknown', { prompt: 'Follow up' }))
      .resolves.toBeNull()
  })
})

describe('ClaudeAgent turn input lifetime', () => {
  test('holds the stream open past the result while a background task is in flight', async () => {
    scriptedMessages = [
      { type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'tool-1' },
      { type: 'result', subtype: 'success', result: 'done' },
      { type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed' },
    ]
    const input = new TurnInputChannel(opening('Kick off a background agent'), 'Kick off a background agent')
    const { events } = new ClaudeAgent().run({ prompt: input, cwd: '/tmp' })
    const stream = events[Symbol.asyncIterator]()

    expect((await stream.next()).value).toMatchObject({ type: 'background_task_started' })
    expect(input.closed).toBe(false)

    // The turn's own result lands, but closing here would cut the SDK query off
    // from the sub-agent that is still running.
    expect((await stream.next()).value).toMatchObject({ type: 'task_complete' })
    expect(input.closed).toBe(false)

    expect((await stream.next()).value).toMatchObject({ type: 'background_task_settled' })
    expect(input.closed).toBe(true)
  })

  test('closes the stream at the result when nothing is backgrounded', async () => {
    scriptedMessages = [{ type: 'result', subtype: 'success', result: 'done' }]
    const input = new TurnInputChannel(opening('Rename the symbol'), 'Rename the symbol')
    const { events } = new ClaudeAgent().run({ prompt: input, cwd: '/tmp' })
    const stream = events[Symbol.asyncIterator]()

    expect((await stream.next()).value).toMatchObject({ type: 'task_complete' })
    expect(input.closed).toBe(true)
  })
})
