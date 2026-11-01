import { expect, test } from 'bun:test'
import { ClaudeTurnNormalizer } from '@solus/server/execution/agents/claude/claude-event-normalizer'
import type { ClaudeEvent } from '@solus/contracts/claude-types'

// WHY: the advisor runs on the server inside the main model's call. Its tokens
// are only in that call's `usage.iterations`, not in the totals the result
// reports, so a turn that consulted the advisor showed far fewer tokens than it
// spent (t3code #24139).

function assistant(id: string, iterations: unknown[], parent: string | null = null): ClaudeEvent {
  return {
    type: 'assistant', parent_tool_use_id: parent, session_id: 's1', uuid: `u-${id}`,
    message: {
      id, model: 'claude-opus', role: 'assistant', stop_reason: null, content: [],
      usage: { input_tokens: 100, output_tokens: 50, iterations },
    },
  } as unknown as ClaudeEvent
}

const result = {
  type: 'result', subtype: 'success', is_error: false, result: 'done',
  session_id: 's1', total_cost_usd: 0.88, duration_ms: 1, num_turns: 1,
  usage: { input_tokens: 100, output_tokens: 50 },
} as unknown as ClaudeEvent

const advisorStep = { type: 'advisor_message', model: 'claude-advisor', input_tokens: 4000, output_tokens: 900, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 }
const mainStep = { type: 'message', input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

function completedUsage(normalizer: ClaudeTurnNormalizer) {
  const done = normalizer.push(result).find((event) => event.type === 'task_complete')
  return done && done.type === 'task_complete' ? done.usage : null
}

test('the turn counts the advisor tokens of its calls once, even when Claude repeats a message', () => {
  const normalizer = new ClaudeTurnNormalizer()
  normalizer.push(assistant('m1', [mainStep, advisorStep]))
  normalizer.push(assistant('m1', [mainStep, advisorStep]))
  expect(completedUsage(normalizer)).toMatchObject({ inputTokens: 4100, outputTokens: 950, cacheReadTokens: 10 })
})

test('main-loop steps and a sub-agent call add nothing, and the next turn starts again from zero', () => {
  const normalizer = new ClaudeTurnNormalizer()
  normalizer.push(assistant('m1', [mainStep]))
  normalizer.push(assistant('m2', [advisorStep], 'task-1'))
  expect(completedUsage(normalizer)).toMatchObject({ inputTokens: 100, outputTokens: 50 })

  normalizer.push(assistant('m3', [advisorStep]))
  expect(completedUsage(normalizer)).toMatchObject({ inputTokens: 4100, outputTokens: 950 })
  expect(completedUsage(normalizer)).toMatchObject({ inputTokens: 100, outputTokens: 50 })
})
