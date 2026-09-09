import { expect, test } from 'bun:test'
import { loadCodexHistory, type CodexItemsListParams } from '@solus/server/agents/codex/codex-history'
import type { CodexTurnHistory } from '@solus/server/agents/codex/codex-utils'

test('a first open reads only the newest requested items, not every turn', async () => {
  const turns: CodexTurnHistory[] = Array.from({ length: 100 }, (_, index) => ({
    id: `turn-${index}`, itemsView: 'summary', items: [], status: 'completed',
  }))
  const requests: CodexItemsListParams[] = []
  const messages = await loadCodexHistory('thread', turns, async (params) => {
    requests.push(params)
    return {
      data: Array.from({ length: 200 }, (_, index) => ({
        turnId: params.turnId,
        item: { id: `tool-${199 - index}`, type: 'commandExecution', command: `echo ${199 - index}`, status: 'completed' },
      })),
      nextCursor: 'older-items',
    }
  }, 200)
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ turnId: 'turn-99', limit: 200, sortDirection: 'desc' })
  expect(messages).toHaveLength(200)
  expect(messages[0].toolInput).toBe('echo 0')
  expect(messages.at(-1)?.toolInput).toBe('echo 199')
})

test('item pages cross turn boundaries in order and retain failure timing', async () => {
  const turns: CodexTurnHistory[] = [
    { id: 'old', itemsView: 'full', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Old prompt' }] }] },
    { id: 'new', itemsView: 'notLoaded', status: 'failed', error: { message: 'Failed command' }, startedAt: 1_700_000_000, completedAt: 1_700_000_003 },
  ]
  const requests: CodexItemsListParams[] = []
  const messages = await loadCodexHistory('thread', turns, async (params) => {
    requests.push(params)
    return params.cursor
      ? { data: [{ turnId: 'new', item: { type: 'userMessage', content: [{ type: 'text', text: 'New prompt' }] } }], nextCursor: null }
      : { data: [{ turnId: 'new', item: { type: 'commandExecution', command: 'false', status: 'failed' } }], nextCursor: 'before-tool' }
  })
  expect(requests.map((request) => request.cursor)).toEqual([undefined, 'before-tool'])
  expect(messages.map((message) => message.role)).toEqual(['user', 'user', 'tool', 'system'])
  expect(messages[1].content).toBe('New prompt')
  expect(messages.at(-1)).toMatchObject({ content: 'Error: Failed command', timestamp: 1_700_000_003_000 })
})

test('skipped provider items do not exhaust the visible history window', async () => {
  const requests: CodexItemsListParams[] = []
  const messages = await loadCodexHistory('thread', [{ id: 'turn', itemsView: 'summary' }], async (params) => {
    requests.push(params)
    return params.cursor
      ? { data: [{ turnId: 'turn', item: { type: 'commandExecution', command: 'pwd' } }], nextCursor: null }
      : { data: [{ turnId: 'turn', item: { type: 'unsupported' } }], nextCursor: 'older' }
  }, 1)
  expect(requests).toHaveLength(2)
  expect(messages[0].toolName).toBe('exec_command')
})

test('full and legacy turns need no extra provider request', async () => {
  const messages = await loadCodexHistory('thread', [
    { items: [{ type: 'commandExecution', command: 'old' }] },
    { itemsView: 'full', items: [{ type: 'commandExecution', command: 'new' }] },
  ], async () => { throw new Error('Unexpected provider read') }, 1)
  expect(messages.map((message) => message.toolInput)).toEqual(['new'])
})

test('a provider error remains an error instead of a successful empty history', async () => {
  await expect(loadCodexHistory('thread', [{ id: 'turn', itemsView: 'summary' }], async () => {
    throw new Error('Disconnected')
  }, 200)).rejects.toThrow('Disconnected')
})

test('a repeated cursor cannot loop indefinitely while opening history', async () => {
  await expect(loadCodexHistory('thread', [{ id: 'turn', itemsView: 'summary' }], async () => ({
    data: [], nextCursor: 'same-cursor',
  }), 200)).rejects.toThrow('repeated an item cursor')
})
