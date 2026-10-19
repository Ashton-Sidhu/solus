import { expect, test } from 'bun:test'
import type { SessionLoadMessage } from '@solus/contracts/session-history'
import { selectSubagentHistory } from '../../packages/server/src/execution/sessions/subagent-history'
import { SubagentHistoryStore } from '@solus/client-core/subagent-history-store'
import { providerSubagentMessages } from '../../packages/workspace-ui/src/components/conversation/lib/subagent-history'

const call: SessionLoadMessage = { role: 'tool', toolId: 'spawn', toolName: 'Agent', content: '', isSubagent: true, timestamp: 1 }

test('only a recorded child call can resolve provider history', () => {
  expect(() => selectSubagentHistory([], 'unrelated', 'codex')).toThrow('does not belong')
  expect(() => selectSubagentHistory([{ ...call, toolName: 'Read', isSubagent: false }], 'spawn', 'codex')).toThrow('does not belong')
  expect(selectSubagentHistory([{ ...call, subagentType: 'codex', toolInput: '{"agent_thread_id":"child-1"}' }], 'spawn', 'codex').threadId).toBe('child-1')
  expect(selectSubagentHistory([{ ...call, sourceProvider: 'claude-code', subagentType: 'codex', toolInput: '{"agent_thread_id":"child-1"}' }], 'spawn', 'codex').threadId).toBeUndefined()
})

test('embedded child history excludes parent and sibling activity', () => {
  const rows = [call,
    { role: 'assistant', content: 'parent', timestamp: 2 },
    { role: 'assistant', content: 'child', parentToolUseId: 'spawn', timestamp: 3 },
    { role: 'assistant', content: 'sibling', parentToolUseId: 'other', timestamp: 4 },
  ]
  expect(selectSubagentHistory(rows, 'spawn', 'claude-code').messages).toEqual([{ role: 'assistant', content: 'child', timestamp: 3 }])
})

test('child reads deduplicate, retain pages on failure, and support retry', async () => {
  let calls = 0
  const history = new SubagentHistoryStore({ loadSessionSubagent: async (request) => {
    calls++
    if (calls === 2) throw new Error('Disconnected')
    return { messages: [{ role: 'assistant', content: request.before ? 'earlier' : 'latest', timestamp: calls }], before: request.before ? null : 'before' }
  } }, { sessionId: 'parent', provider: 'codex', toolId: 'spawn' })
  const first = history.load()
  expect(history.load()).toBe(first)
  await first
  await history.load(true)
  expect(history.read().error).toBe('Disconnected')
  expect(history.read().page.messages[0].content).toBe('latest')
  await history.load(true)
  expect(history.read().page.messages.map((row) => row.content)).toEqual(['earlier', 'latest'])
  expect(history.read().page.before).toBeNull()
})

test('the desktop child view correlates tool completion and report', () => {
  const messages = providerSubagentMessages([
    { role: 'tool', toolId: 'read', toolName: 'Read', toolStatus: 'running', content: '', timestamp: 1 },
    { role: 'tool_result', toolResultForId: 'read', content: '', status: 'error', errorHead: 'Missing file', timestamp: 2 },
    { role: 'assistant', content: 'The file is missing.', timestamp: 3 },
  ])
  expect(messages).toHaveLength(2)
  expect(messages[0].toolStatus).toBe('error')
  expect(messages[0].errorHead).toBe('Missing file')
  expect(messages[0].toolCompletedAt).toBe(2)
})
