import { expect, test } from 'bun:test'
import { CodexTurnNormalizer } from '@solus/server/agents/codex/codex-event-normalizer'
import { reconcileCodexSubagentHistory } from '@solus/server/agents/codex/codex-subagent-history'
import { loadCodexHistory } from '@solus/server/agents/codex/codex-history'
import { codexItemToMessage } from '@solus/server/agents/codex/codex-utils'
import { projectSessionEvent, projectSessionHistory } from '@solus/server/server/result-projection'
import type { SessionLoadMessage } from '@solus/contracts/session-history'

const spawn = {
  id: 'spawn-1', type: 'subAgentActivity', kind: 'started',
  agentThreadId: 'child-1', agentPath: '/root/audit',
}

function card(): SessionLoadMessage {
  return codexItemToMessage(spawn, 1000)!
}

test('a successful child turn settles its card without completing the parent turn', () => {
  const normalizer = new CodexTurnNormalizer({ planMode: false })
  normalizer.push({ method: 'item/completed', params: { threadId: 'parent', item: spawn } })
  const events = normalizer.push({
    method: 'turn/completed',
    params: {
      threadId: 'child-1',
      turn: { status: 'completed', items: [{ type: 'agentMessage', text: 'Audit complete.' }] },
    },
  })
  expect(events.map(projectSessionEvent)).toEqual([{
    type: 'subagent_report', toolUseId: 'spawn-1', text: 'Audit complete.',
  }])
  // An agent is reusable: follow-up work must reopen this same card.
  expect(normalizer.push({
    method: 'turn/started', params: { threadId: 'child-1', turn: { status: 'inProgress' } },
  }).map(projectSessionEvent)).toEqual([{ type: 'subagent_running', toolUseId: 'spawn-1' }])
})

test('completion without a final message still stops the spinner', () => {
  const normalizer = new CodexTurnNormalizer({ planMode: false })
  normalizer.push({ method: 'item/completed', params: { threadId: 'parent', item: spawn } })
  expect(normalizer.push({
    method: 'turn/completed', params: { threadId: 'child-1', turn: { status: 'completed' } },
  }).map(projectSessionEvent)).toEqual([{
    type: 'subagent_report', toolUseId: 'spawn-1', text: 'Done',
  }])
})

test('paginated spawn history restores the child completion and report', async () => {
  const messages = await loadCodexHistory('parent', [{ id: 'turn', itemsView: 'summary' }], async () => ({
    data: [{ turnId: 'turn', item: spawn }],
  }), 20)
  await reconcileCodexSubagentHistory(messages, async (threadId) => {
    expect(threadId).toBe('child-1')
    return [{ status: 'completed', items: [{ type: 'agentMessage', text: 'Audit complete.' }] }]
  })
  expect(projectSessionHistory(messages)[0]).toMatchObject({
    toolStatus: 'completed', report: 'Audit complete.',
  })
})

test('the latest child turn can be running again after an earlier final answer', async () => {
  const messages = [card()]
  await reconcileCodexSubagentHistory(messages, async () => [
    { status: 'completed', items: [{ type: 'agentMessage', text: 'First answer.' }] },
    { status: 'inProgress' },
  ])
  expect(messages[0].toolStatus).toBe('running')
})

test.each(['failed', 'interrupted'])('restores %s children as failed cards', async (status) => {
  const messages = [card()]
  await reconcileCodexSubagentHistory(messages, async () => [{ status }])
  expect(messages[0].toolStatus).toBe('error')
})

test('unavailable children preserve the known state and do not block parent history', async () => {
  const messages = [card()]
  await reconcileCodexSubagentHistory(messages, async () => { throw new Error('Unavailable') })
  expect(messages[0].toolStatus).toBe('running')
})

test('reads each child once and skips unrelated tool messages', async () => {
  const messages = [card(), card(), { role: 'tool', content: '', timestamp: 1, toolName: 'exec_command' }]
  const reads: string[] = []
  await reconcileCodexSubagentHistory(messages, async (threadId) => {
    reads.push(threadId)
    return [{ status: 'completed' }]
  })
  expect(reads).toEqual(['child-1'])
  expect(messages.slice(0, 2).map((message) => message.toolStatus)).toEqual(['completed', 'completed'])
})
