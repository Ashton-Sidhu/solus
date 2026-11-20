import { expect, test } from 'bun:test'
import { ClaudeTurnNormalizer } from '@solus/server/execution/agents/claude/claude-event-normalizer'
import { MAX_PARTIAL_INPUT_CHARS, PARTIAL_INPUT_INTERVAL_MS } from '@solus/server/execution/agents/claude/claude-partial-input'
import type { ClaudeEvent } from '@solus/contracts/claude-types'

// WHY: a live MCP App card shows a Solus integration tool's input while the
// model writes it (docs/plans/mcp-first-class.md §14.1). Every other tool keeps
// its input until it is whole, and the stream stays at ten updates a second.

const stream = (event: unknown, parent: string | null = null) =>
  ({ type: 'stream_event', parent_tool_use_id: parent, session_id: 's1', uuid: 'u', event }) as unknown as ClaudeEvent
const start = (name: string, id = 'toolu_1', parent: string | null = null) =>
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }, parent)
const delta = (text: string, parent: string | null = null) =>
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: text } }, parent)
const stop = stream({ type: 'content_block_stop', index: 0 })

function normalizer() {
  let now = 1000
  const claude = new ClaudeTurnNormalizer(() => now)
  return { claude, advance: (ms: number) => { now += ms } }
}

test('an integration tool streams its input so far, ten times a second at most, and still ends with the whole input', () => {
  const { claude, advance } = normalizer()
  claude.push(start('mcp__solus__charts__chart'))
  expect(claude.push(delta('{"region'))).toEqual([{ type: 'tool_call_update', toolId: 'toolu_1', index: 0, toolInput: '{"region', inputPartial: true }])
  expect(claude.push(delta('":"we'))).toEqual([])
  advance(PARTIAL_INPUT_INTERVAL_MS)
  expect(claude.push(delta('st"'))).toEqual([{ type: 'tool_call_update', toolId: 'toolu_1', index: 0, toolInput: '{"region":"west"', inputPartial: true }])
  expect(claude.push(delta('}'))).toEqual([])
  expect(claude.push(stop)).toEqual([{ type: 'tool_call_complete', index: 0, toolInput: '{"region":"west"}' }])
})

test('other tools, calls inside a subagent, and a very long input send no partial input', () => {
  const builtIn = normalizer().claude
  builtIn.push(start('Bash'))
  expect(builtIn.push(delta('{"command":"ls'))).toEqual([])
  const solusTool = normalizer().claude
  solusTool.push(start('mcp__solus__create_work'))
  expect(solusTool.push(delta('{"title":"x'))).toEqual([])
  const subagent = normalizer().claude
  subagent.push(start('mcp__solus__charts__chart', 'toolu_2', 'toolu_parent'))
  expect(subagent.push(delta('{"region":"w', 'toolu_parent'))).toEqual([])
  const long = normalizer()
  long.claude.push(start('mcp__solus__charts__chart'))
  long.claude.push(delta('{"text":"'))
  long.advance(PARTIAL_INPUT_INTERVAL_MS)
  expect(long.claude.push(delta('x'.repeat(MAX_PARTIAL_INPUT_CHARS)))).toEqual([])
})
