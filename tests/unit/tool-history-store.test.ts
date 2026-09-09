import { expect, test } from 'bun:test'
import { ToolHistoryStore } from '@solus/workspace-ui/contexts/workspace/tool-history.store'
import type { Message } from '@solus/contracts/types'
import type { SessionToolInput, SessionToolInputsRequest } from '@solus/contracts/session-history'

function tool(key: string, serverId = 'phone-host'): Message {
  return { id: key, role: 'tool', toolName: 'Read', content: '', timestamp: 1,
    historyToolInput: { serverId, sessionId: 'session', provider: 'codex', projectPath: '/repo', key } }
}

test('nothing loads before a click; overlapping summaries share reads and keep fetched inputs', async () => {
  const calls: SessionToolInputsRequest[] = []
  let finish!: (inputs: SessionToolInput[]) => void
  const store = new ToolHistoryStore(() => ({ loadSessionToolInputs: (request) => {
    calls.push(request)
    return new Promise((resolve) => { finish = resolve })
  } }))
  const messages = [tool('A'), tool('B')]
  expect(calls).toHaveLength(0)
  const first = store.load(messages)
  const second = store.load([messages[0]])
  expect(calls).toHaveLength(1)
  expect(messages[0].historyToolInput?.loading).toBe(true)
  finish([{ key: 'A', toolInput: 'first' }, { key: 'B', toolInput: 'second' }])
  await Promise.all([first, second])
  expect(messages.map((message) => message.toolInput)).toEqual(['first', 'second'])
  expect(messages.every((message) => !message.historyToolInput)).toBe(true)
  await store.load(messages)
  expect(calls).toHaveLength(1)
})

test('failure clears loading and the summary can retry', async () => {
  let fail = true
  const store = new ToolHistoryStore(() => ({ loadSessionToolInputs: async () => {
    if (fail) throw new Error('Disconnected')
    return [{ key: 'A', toolInput: 'recovered' }]
  } }))
  const message = tool('A')
  await store.load([message])
  expect(message.historyToolInput).toMatchObject({ loading: false, error: 'Could not load tool details. Try again.' })
  fail = false
  await store.load([message])
  expect(message.toolInput).toBe('recovered')
  expect(message.historyToolInput).toBeUndefined()
})

test('a late read cannot overwrite a new history reference or live input', async () => {
  let finish!: (inputs: SessionToolInput[]) => void
  const store = new ToolHistoryStore(() => ({ loadSessionToolInputs: () => new Promise((resolve) => { finish = resolve }) }))
  const message = tool('A')
  const loading = store.load([message])
  message.historyToolInput = tool('B').historyToolInput
  finish([{ key: 'A', toolInput: 'stale' }]); await loading
  expect(message.toolInput).toBeUndefined()
  expect(message.historyToolInput?.key).toBe('B')
  const next = store.load([message])
  message.toolInput = 'live input'
  finish([{ key: 'B', toolInput: 'disk input' }]); await next
  expect(message.toolInput).toBe('live input')
})

test('identical session ids on different hosts read their own source', async () => {
  const hosts: string[] = []
  const store = new ToolHistoryStore((serverId) => ({ loadSessionToolInputs: async () => {
    hosts.push(serverId)
    return [{ key: 'A', toolInput: serverId }]
  } }))
  const messages = [tool('A', 'one'), tool('A', 'two')]
  await store.load(messages)
  expect(hosts.sort()).toEqual(['one', 'two'])
  expect(messages.map((message) => message.toolInput)).toEqual(['one', 'two'])
})

test('large expanded summaries use bounded batches and missing inputs can retry', async () => {
  const sizes: number[] = []
  const store = new ToolHistoryStore(() => ({ loadSessionToolInputs: async (request) => {
    sizes.push(request.keys.length)
    return request.keys.filter((key) => key !== 'missing').map((key) => ({ key, toolInput: key }))
  } }))
  const messages = Array.from({ length: 201 }, (_, index) => tool(String(index)))
  messages.push(tool('missing'))
  await store.load(messages)
  expect(sizes).toEqual([200, 2])
  expect(messages.at(-1)?.historyToolInput?.error).toContain('no longer available')
  expect(messages[200].toolInput).toBe('200')
})
