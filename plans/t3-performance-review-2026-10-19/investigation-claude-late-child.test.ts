import { expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const realCliEnv = await import('@solus/server/cli-env')
mock.module('@solus/server/cli-env', () => ({ ...realCliEnv, warmCliPath: async () => '/fixture/bin', findOnPath: () => '/fixture/bin/claude' }))
const realSdk = await import('@anthropic-ai/claude-agent-sdk')
const messages = [
  { type: 'system', subtype: 'init', session_id: 'fixture-root', model: 'fixture-model', skills: [] },
  { type: 'system', subtype: 'task_started', task_id: 'background-parent', tool_use_id: 'parent-tool' },
  { type: 'result', subtype: 'success', is_error: false, result: 'Synthetic root settled.' },
  { type: 'stream_event', parent_tool_use_id: 'parent-tool', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Agent', id: 'nested-tool' } } },
  { type: 'system', subtype: 'task_started', task_id: 'background-nested', tool_use_id: 'nested-tool' },
  { type: 'system', subtype: 'task_notification', task_id: 'background-parent', status: 'completed' },
  { type: 'stream_event', parent_tool_use_id: 'nested-tool', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Synthetic nested progress.' } } },
  { type: 'system', subtype: 'task_notification', task_id: 'background-nested', status: 'completed' },
  { type: 'result', subtype: 'success', is_error: false, result: 'Synthetic notification settled.', origin: { kind: 'task-notification' } },
]
mock.module('@anthropic-ai/claude-agent-sdk', () => ({ ...realSdk, query: () => Object.assign((async function* () { for (const msg of messages) yield msg })(), { stopTask: async () => {} }) }))

test('20835: a child launched after the root result is emitted at once under its original parent on the open query', async () => {
  const { ClaudeAgent } = await import('@solus/server/execution/agents/claude/claude-agent')
  const { TurnInputChannel } = await import('@solus/server/execution/agents/claude/claude-turn-input')
  const input = new TurnInputChannel({ type: 'user', message: { role: 'user', content: 'Synthetic prompt' }, parent_tool_use_id: null }, 'Synthetic prompt')
  const { events, result } = new ClaudeAgent().run({ prompt: input, cwd: import.meta.dir })
  const stream = events[Symbol.asyncIterator]()
  let next = await stream.next()
  while (!next.done && next.value.type !== 'task_complete') next = await stream.next()
  expect(next.value?.type).toBe('task_complete')
  expect(input.closed).toBe(false)
  expect((await stream.next()).value).toMatchObject({ type: 'tool_call', toolId: 'nested-tool', parentToolUseId: 'parent-tool', isSubagent: true })
  expect(input.closed).toBe(false)
  expect((await stream.next()).value).toMatchObject({ type: 'background_task_started', taskId: 'background-nested', toolUseId: 'nested-tool' })
  expect((await stream.next()).value).toMatchObject({ type: 'background_task_settled', taskId: 'background-parent' })
  expect(input.closed).toBe(false)
  expect((await stream.next()).value).toMatchObject({ type: 'text_chunk', parentToolUseId: 'nested-tool', text: 'Synthetic nested progress.' })
  while (!(await stream.next()).done) {}
  expect(input.closed).toBe(true)
  expect((await result).sessionId).toBe('fixture-root')
})
