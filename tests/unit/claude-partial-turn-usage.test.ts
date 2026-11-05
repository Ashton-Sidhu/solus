import { describe, expect, mock, test } from 'bun:test'
import type { ClaudeEvent, ResultEvent } from '@solus/contracts/claude-types'
import type { NormalizedEvent } from '@solus/contracts/types'

// WHY: a Claude turn that is stopped or fails gets no success result, and only
// that result used to carry the turn's tokens. Insights and goals then recorded
// nothing for calls that were already spent (t3code #25200).

const realCliEnv = await import('@solus/server/cli-env')
mock.module('@solus/server/cli-env', () => ({
  ...realCliEnv,
  warmCliPath: async () => '/fixture/bin',
  findOnPath: () => '/fixture/bin/claude',
  startableCommand: () => ({ file: '/fixture/bin/claude.exe', args: [] }),
}))

/** What the mocked SDK replays before it throws `scriptedError`, if any. */
let scriptedMessages: unknown[] = []
let scriptedError: Error | null = null
const realSdk = await import('@anthropic-ai/claude-agent-sdk')
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: () => Object.assign((async function* () {
    for (const msg of scriptedMessages) yield msg
    if (scriptedError) throw scriptedError
  })(), { stopTask: async () => {}, getContextUsage: async () => null }),
}))

const { ClaudeTurnNormalizer } = await import('@solus/server/execution/agents/claude/claude-event-normalizer')
const { ClaudeAgent } = await import('@solus/server/execution/agents/claude/claude-agent')

function assistant(id: string, inputTokens: number, outputTokens: number, parent: string | null = null): ClaudeEvent {
  return {
    type: 'assistant', parent_tool_use_id: parent, session_id: 's1', uuid: `u-${id}`,
    message: {
      id, model: 'claude-opus', role: 'assistant', stop_reason: null, content: [],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_input_tokens: 1000 },
    },
  } as unknown as ClaudeEvent
}

function result(fields: Partial<ResultEvent>): ClaudeEvent {
  return {
    type: 'result', subtype: 'success', is_error: false, session_id: 's1',
    total_cost_usd: 0, duration_ms: 0, num_turns: 1, usage: { input_tokens: 0, output_tokens: 0 },
    ...fields,
  } as unknown as ClaudeEvent
}

const seam = result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' })

function partialTurns(events: NormalizedEvent[]) {
  return events.flatMap((event) => event.type === 'usage' && event.partialTurn ? [event.partialTurn] : [])
}

describe('ClaudeTurnNormalizer partial usage', () => {
  test('a stopped turn reports the main-thread calls it made, each once, across a seam', () => {
    const normalizer = new ClaudeTurnNormalizer()
    const events = [
      ...normalizer.push(assistant('m1', 100, 20)),
      // Claude repeats a message once per content block; it is one call.
      ...normalizer.push(assistant('m1', 100, 20)),
      // A sub-agent's call is its own accounting, not the main loop's.
      ...normalizer.push(assistant('sub', 9000, 900, 'task-1')),
      ...normalizer.push(seam),
      ...normalizer.push(assistant('m2', 50, 10)),
    ]
    expect(partialTurns(events)).toEqual([])

    normalizer.interrupt()
    expect(normalizer.takeUnreportedUsage()).toEqual({
      type: 'usage',
      partialTurn: { usage: { inputTokens: 150, outputTokens: 30, cacheReadTokens: 2000 } },
    })
    expect(normalizer.takeUnreportedUsage()).toBeNull()
  })

  test('a failed turn reports its calls with the cost and time the error result carries', () => {
    const normalizer = new ClaudeTurnNormalizer()
    normalizer.push(assistant('m1', 100, 20))
    const events = normalizer.push(result({
      subtype: 'error_during_execution', is_error: true, errors: ['API Error: 500'],
      total_cost_usd: 0.04, duration_ms: 900,
    }))

    expect(events.find((event) => event.type === 'error')).toMatchObject({ message: 'API Error: 500' })
    expect(partialTurns(events)).toEqual([{
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 1000 },
      costUsd: 0.04,
      durationMs: 900,
    }])
    expect(normalizer.takeUnreportedUsage()).toBeNull()
  })

  test('a failed turn whose result reports tokens keeps the result authoritative', () => {
    const normalizer = new ClaudeTurnNormalizer()
    normalizer.push(assistant('m1', 100, 20))
    const events = normalizer.push(result({
      subtype: 'error_max_turns', is_error: true, usage: { input_tokens: 400, output_tokens: 80 },
    }))
    expect(partialTurns(events)).toEqual([{ usage: { inputTokens: 400, outputTokens: 80 } }])
  })

  test('a successful turn records exactly the final result usage, once', () => {
    const normalizer = new ClaudeTurnNormalizer()
    const events = [
      ...normalizer.push(assistant('m1', 100, 20)),
      ...normalizer.push(assistant('m2', 50, 10)),
      ...normalizer.push(result({ result: 'done', total_cost_usd: 0.02, usage: { input_tokens: 150, output_tokens: 30 } })),
    ]

    expect(partialTurns(events)).toEqual([])
    const completed = events.filter((event) => event.type === 'task_complete')
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({ costUsd: 0.02, usage: { inputTokens: 150, outputTokens: 30 } })
    expect(normalizer.takeUnreportedUsage()).toBeNull()
  })

  // The CLI's headless session starts each turn's usage at zero and a seam's
  // result ends that turn, so the success after a seam reports only its own
  // segment. Its cost is the query's running total and needs nothing added.
  test('a success after a seam adds the segment before the seam, once', () => {
    const normalizer = new ClaudeTurnNormalizer()
    const events = [
      ...normalizer.push(assistant('m1', 100, 20)),
      // The seam's own report is the segment's spend; m1 must not count again.
      ...normalizer.push(result({ ...seam, usage: { input_tokens: 120, output_tokens: 25 } } as Partial<ResultEvent>)),
      ...normalizer.push(assistant('m2', 50, 10)),
      ...normalizer.push(result({ result: 'done', total_cost_usd: 0.03, usage: { input_tokens: 50, output_tokens: 10 } })),
    ]

    expect(partialTurns(events)).toEqual([])
    const completed = events.filter((event) => event.type === 'task_complete')
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({ costUsd: 0.03, usage: { inputTokens: 170, outputTokens: 35 } })
    expect(normalizer.takeUnreportedUsage()).toBeNull()

    // The next turn starts again from its own report.
    const next = normalizer.push(result({ result: 'again', usage: { input_tokens: 7, output_tokens: 1 } }))
    expect(next.find((event) => event.type === 'task_complete')).toMatchObject({ usage: { inputTokens: 7, outputTokens: 1 } })
  })
})

describe('ClaudeAgent partial usage', () => {
  async function drain(): Promise<NormalizedEvent[]> {
    const { events, result: settled } = new ClaudeAgent().run({ prompt: 'Refactor the parser', cwd: '/tmp' })
    settled.catch(() => {})
    const seen: NormalizedEvent[] = []
    for await (const event of events) seen.push(event)
    return seen
  }

  test('a turn the user stops reports what its calls already spent', async () => {
    scriptedMessages = [assistant('m1', 100, 20)]
    scriptedError = Object.assign(new Error('aborted'), { name: 'AbortError' })
    expect(partialTurns(await drain())).toEqual([{ usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 1000 } }])
  })

  test('a successful turn adds no partial usage when its stream ends', async () => {
    scriptedMessages = [assistant('m1', 100, 20), result({ result: 'done', usage: { input_tokens: 100, output_tokens: 20 } })]
    scriptedError = null
    const events = await drain()
    expect(partialTurns(events)).toEqual([])
    expect(events.filter((event) => event.type === 'task_complete')).toHaveLength(1)
  })
})
