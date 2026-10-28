import { describe, expect, test } from 'bun:test'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import { messageItemId, readTimeline, type TimelineRequest } from '@solus/server/execution/agents/tools/session-timeline'

// WHY: an agent reads another session to act on what it said: a worker's
// report, a plan, a past decision. The read must not lose that text, must not
// fill a page with tool rows, and must let the agent reach any part of a long
// session by position, the way T3 Code's thread read does.

const request = (overrides: Partial<TimelineRequest> = {}): TimelineRequest => ({
  view: 'messages', afterPosition: -1, limit: 50, maxCharsPerItem: 20_000, ...overrides,
})

const busyTurn: SessionLoadMessage[] = [
  { role: 'user', content: 'Run the tests.', timestamp: 1000 },
  { role: 'tool', content: '', toolName: 'Bash', toolId: 'tool-1', toolInput: '{"command":"bun test"}', timestamp: 2000 },
  { role: 'tool_result', content: '3 fail', toolResultForId: 'tool-1', toolResultIsError: true, timestamp: 3000 },
  { role: 'reasoning', content: 'Look at the failures.', timestamp: 4000 },
  { role: 'assistant', content: 'Inside the subagent.', parentToolUseId: 'tool-1', timestamp: 4500 },
  { role: 'assistant', content: 'Three tests fail.', timestamp: 5000 },
]

describe('readTimeline', () => {
  test('the messages view is not crowded out by tool rows, and positions count every item', () => {
    const page = readTimeline(busyTurn, request())
    expect(page.items.map((item) => [item.position, item.type, item.text])).toEqual([
      [0, 'user_message', 'Run the tests.'],
      [3, 'assistant_message', 'Three tests fail.'],
    ])
    expect(page.itemCount).toBe(4)
  })

  test('the activity view shows a tool call with its output and outcome as one item', () => {
    const tool = readTimeline(busyTurn, request({ view: 'activity' })).items.find((item) => item.type === 'tool')
    expect(tool).toMatchObject({ itemId: 'tool-1', title: 'Bash', status: 'error', text: '{"command":"bun test"}\n3 fail' })
  })

  test('rows inside a subagent stay off the parent timeline', () => {
    const texts = readTimeline(busyTurn, request({ view: 'activity' })).items.map((item) => item.text)
    expect(texts).not.toContain('Inside the subagent.')
  })

  test('pages continue from nextPosition without repeating or skipping', () => {
    const rows: SessionLoadMessage[] = [1, 2, 3, 4, 5].map((n) => ({ role: n % 2 ? 'user' : 'assistant', content: `message ${n}`, timestamp: n }))
    const first = readTimeline(rows, request({ limit: 2 }))
    expect(first.items.map((item) => item.text)).toEqual(['message 1', 'message 2'])
    expect(first.hasMore).toBe(true)
    const second = readTimeline(rows, request({ limit: 10, afterPosition: first.nextPosition! }))
    expect(second.items.map((item) => item.text)).toEqual(['message 3', 'message 4', 'message 5'])
    expect(second.hasMore).toBe(false)
  })

  test('a long message keeps its lines and its cut-off text can be read on', () => {
    const report = 'Line one\n\n```ts\nconst x = 1\n```\nLine three'
    const rows: SessionLoadMessage[] = [{ role: 'assistant', content: report, messageId: 'm1', timestamp: 1 }]
    const head = readTimeline(rows, request({ maxCharsPerItem: 12 })).items[0]!
    expect(head).toMatchObject({ text: report.slice(0, 12), textTruncated: true, nextTextOffset: 12 })
    const rest = readTimeline(rows, request({ itemId: 'm1', textOffset: 12, maxCharsPerItem: 1000 })).items[0]!
    expect(head.text! + rest.text!).toBe(report)
    expect(rest.textTruncated).toBe(false)
  })

  test('the item id search_sessions names opens that message, with or without a provider id', () => {
    // Claude history rows carry no message id; Codex rows do.
    const rows: SessionLoadMessage[] = [
      { role: 'user', content: 'Which database?', timestamp: 1000 },
      { role: 'assistant', content: 'SQLite.', timestamp: 2000 },
      { role: 'assistant', content: 'From Codex.', messageId: 'codex-item', timestamp: 3000 },
    ]
    const claude = readTimeline(rows, request({ itemId: messageItemId('assistant', null, 2000) }))
    expect(claude.items.map((item) => [item.position, item.text])).toEqual([[1, 'SQLite.']])
    const codex = readTimeline(rows, request({ itemId: messageItemId('assistant', 'codex-item', 3000) }))
    expect(codex.items.map((item) => item.text)).toEqual(['From Codex.'])
  })
})
