import { describe, expect, test } from 'bun:test'
import { CodexTurnNormalizer } from '../../src/main/agents/codex/codex-event-normalizer'
import { ClaudeTurnNormalizer } from '../../src/main/agents/claude/claude-event-normalizer'
import {
  contextLimit,
  contextTokensUsed,
  contextUsedFraction,
} from '../../src/renderer/lib/contextUsage'
import { defaultContextWindowFor } from '../../src/shared/types'
import type { ContextUsage, NormalizedEvent, Session } from '../../src/shared/types'

/**
 * The context meter answers one question: how much room is left before this
 * session loses history. Both providers also report *cumulative* token spend
 * for the whole thread, which passes the window many times over in a long
 * session — every test here exists to keep those two apart.
 */

type UsageEvent = Extract<NormalizedEvent, { type: 'usage' }>

function usageEvents(events: NormalizedEvent[]): UsageEvent[] {
  return events.filter((event): event is UsageEvent => event.type === 'usage')
}

function sessionWith(overrides: Partial<Session>): Session {
  return {
    run: {
      provider: 'claude-code',
      modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
    } as Session['run'],
    sessionModel: null,
    contextUsage: null,
    ...overrides,
  } as Session
}

describe('Claude context usage', () => {
  // Real numbers from a 15-turn run: the result event's cumulative cache reads
  // came to 1.55M while the window itself held ~147K. Reporting the former as
  // occupancy pegs the meter at 100% for the rest of the session.
  test('reads the window off each API call, never the run total', () => {
    const normalizer = new ClaudeTurnNormalizer()
    const events = normalizer.push({
      type: 'assistant',
      message: {
        model: 'claude-opus-5',
        id: 'msg_1',
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        stop_reason: null,
        usage: {
          input_tokens: 21,
          output_tokens: 8381,
          cache_read_input_tokens: 146_385,
          cache_creation_input_tokens: 356,
        },
      },
      parent_tool_use_id: null,
      session_id: 'sess-1',
      uuid: 'uuid-1',
    } as any)

    expect(usageEvents(events).map((event) => event.context)).toEqual([{
      usedTokens: 146_762,
      inputTokens: 21,
      cacheReadTokens: 146_385,
      cacheCreationTokens: 356,
    }])
  })

  // A sub-agent runs its own window. Letting its small prompt land on the main
  // meter would report a nearly-empty context for a session about to compact.
  test('ignores a sub-agent call, which occupies a different window', () => {
    const normalizer = new ClaudeTurnNormalizer()
    const events = normalizer.push({
      type: 'assistant',
      message: {
        model: 'claude-opus-5',
        id: 'msg_2',
        role: 'assistant',
        content: [{ type: 'text', text: 'sub-agent thinking' }],
        stop_reason: null,
        usage: { input_tokens: 12, output_tokens: 40, cache_read_input_tokens: 8_000 },
      },
      parent_tool_use_id: 'toolu_parent',
      session_id: 'sess-1',
      uuid: 'uuid-2',
    } as any)

    expect(usageEvents(events)).toEqual([])
  })

  test('reports the completed run as spend, not as occupancy', () => {
    const normalizer = new ClaudeTurnNormalizer()
    const events = normalizer.push({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      total_cost_usd: 1.42,
      duration_ms: 1000,
      num_turns: 15,
      session_id: 'sess-1',
      usage: {
        input_tokens: 21,
        output_tokens: 8381,
        cache_read_input_tokens: 1_548_369,
        cache_creation_input_tokens: 12_074,
      },
    } as any)

    expect(usageEvents(events)).toEqual([])
    expect(events.some((event) => event.type === 'task_complete')).toBe(true)
  })
})

describe('Codex context usage', () => {
  // Numbers lifted from a live thread: `total` had climbed past 1M while the
  // window held a steady 53K.
  test('takes the window from `last` and the spend from `total`', () => {
    const events = new CodexTurnNormalizer({ planMode: false }).push({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          total: {
            totalTokens: 1_018_689,
            inputTokens: 1_014_900,
            cachedInputTokens: 895_744,
            cacheWriteInputTokens: 0,
            outputTokens: 3_789,
            reasoningOutputTokens: 1_197,
          },
          last: {
            totalTokens: 53_611,
            inputTokens: 53_491,
            cachedInputTokens: 51_968,
            cacheWriteInputTokens: 0,
            outputTokens: 120,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 258_000,
        },
      },
    })

    expect(usageEvents(events)).toEqual([{
      type: 'usage',
      context: {
        usedTokens: 53_611,
        windowTokens: 258_000,
        inputTokens: 1_523,
        cacheReadTokens: 51_968,
        outputTokens: 120,
      },
      run: {
        inputTokens: 119_156,
        outputTokens: 3_789,
        cacheReadTokens: 895_744,
        reasoningTokens: 1_197,
      },
    }])
  })

  test('separates cache writes from ordinary input for pricing', () => {
    const events = new CodexTurnNormalizer({ planMode: false }).push({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          total: {
            totalTokens: 105,
            inputTokens: 100,
            cachedInputTokens: 20,
            cacheWriteInputTokens: 10,
            outputTokens: 5,
            reasoningOutputTokens: 2,
          },
          last: {
            totalTokens: 105,
            inputTokens: 100,
            cachedInputTokens: 20,
            cacheWriteInputTokens: 10,
            outputTokens: 5,
            reasoningOutputTokens: 2,
          },
          modelContextWindow: 258_000,
        },
      },
    })

    expect(usageEvents(events)[0]).toEqual({
      type: 'usage',
      context: {
        usedTokens: 105,
        windowTokens: 258_000,
        inputTokens: 70,
        cacheReadTokens: 20,
        cacheCreationTokens: 10,
        outputTokens: 5,
      },
      run: {
        inputTokens: 70,
        outputTokens: 5,
        cacheReadTokens: 20,
        cacheCreationTokens: 10,
        reasoningTokens: 2,
      },
    })
  })
})

describe('contextLimit', () => {
  test('measures against the provider effective window', () => {
    const session = sessionWith({
      contextUsage: { usedTokens: 100_000, windowTokens: 200_000, compactAtTokens: 168_000 },
    })
    expect(contextLimit(session)).toBe(200_000)
  })

  test('uses the compaction threshold only when no effective window was reported', () => {
    const session = sessionWith({ contextUsage: { usedTokens: 100_000, compactAtTokens: 168_000 } })
    expect(contextLimit(session)).toBe(168_000)
  })

  test('falls back to the window the run reported', () => {
    const session = sessionWith({ contextUsage: { usedTokens: 40_000, windowTokens: 258_000 } })
    expect(contextLimit(session)).toBe(258_000)
  })

  // Before the first turn there is no report at all, and the profile is the
  // only source. `defaultContextWindow` is what the session will actually run.
  test('falls back to the model profile before anything has been reported', () => {
    const session = sessionWith({ sessionModel: 'claude-haiku-4-5-20251001' })
    expect(contextLimit(session)).toBe(200_000)
  })

  test('prefers an explicitly selected window over the profile default', () => {
    const session = sessionWith({
      sessionModel: 'claude-haiku-4-5-20251001',
      run: { modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: 1_000_000, fastMode: false } } as Session['run'],
    })
    expect(contextLimit(session)).toBe(1_000_000)
  })
})

describe('contextUsedFraction', () => {
  test('measures occupancy against the limit', () => {
    expect(contextUsedFraction(42_000, 200_000)).toBeCloseTo(0.21)
  })

  // Providers can overshoot their own compaction threshold before compacting,
  // and a bar past 100% would render outside its track.
  test('caps at full once a provider overruns its own threshold', () => {
    expect(contextUsedFraction(180_000, 168_000)).toBe(1)
  })

  test('reads empty when nothing has been reported yet', () => {
    const session = sessionWith({})
    expect(contextUsedFraction(contextTokensUsed(session), contextLimit(session))).toBe(0)
  })
})

describe('defaultContextWindowFor', () => {
  // The meter divides by this before a provider reports, and the backend routes
  // on it (`[1m]`). If the two disagree the percentage is wrong by that ratio.
  test('resolves the window the model actually runs with', () => {
    expect(defaultContextWindowFor('claude-code', 'claude-opus-5')).toBe(1_000_000)
    expect(defaultContextWindowFor('claude-code', 'claude-haiku-4-5-20251001')).toBe(200_000)
  })

  test('yields null when there is no model to resolve against', () => {
    expect(defaultContextWindowFor('claude-code', null)).toBeNull()
    expect(defaultContextWindowFor(null, 'claude-opus-5')).toBeNull()
    expect(defaultContextWindowFor('claude-code', 'not-a-model')).toBeNull()
  })
})

describe('persisted snapshot', () => {
  // Neither provider's transcript carries token counts, so a resumed tab has
  // only its own snapshot to go on until the next turn reports.
  test('a restored snapshot drives the meter with no live report', () => {
    const restored: ContextUsage = { usedTokens: 150_000, windowTokens: 200_000, compactAtTokens: 168_000 }
    const session = sessionWith({ contextUsage: restored })
    expect(contextTokensUsed(session)).toBe(150_000)
    expect(contextUsedFraction(contextTokensUsed(session), contextLimit(session))).toBeCloseTo(0.75, 2)
  })
})
