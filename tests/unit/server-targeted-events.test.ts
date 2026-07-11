import { describe, expect, test } from 'bun:test'
import { SolusServer } from '../../src/main/server/server'
import type { RpcTopic } from '../../src/shared/rpc'

interface ReceivedEvent {
  topic: RpcTopic
  payload: unknown[]
  seq?: number
}

function captureClient(server: SolusServer, clientId: string): {
  events: ReceivedEvent[]
  unsubscribe: () => void
} {
  const events: ReceivedEvent[] = []
  const unsubscribe = server.registerDirectClient(clientId, (topic, payload, seq) => {
    events.push({ topic, payload, seq })
  })
  return { events, unsubscribe }
}

describe('SolusServer targeted event routing', () => {
  test('delivers each tab event only to its owning client with independent sequences', () => {
    const server = new SolusServer()
    const clientA = captureClient(server, 'ws:a')
    const clientB = captureClient(server, 'ws:b')

    server.sendTargeted('ws:a', 'normalized-event', 'tab-a', { type: 'assistant_message', text: 'A' })
    server.sendTargeted('ws:b', 'normalized-event', 'tab-b', { type: 'assistant_message', text: 'B' })
    server.sendTargeted('ws:a', 'normalized-event', 'tab-a', { type: 'task_complete' })

    expect(clientA.events.map(({ payload, seq }) => ({ tabId: payload[0], seq }))).toEqual([
      { tabId: 'tab-a', seq: 1 },
      { tabId: 'tab-a', seq: 2 },
    ])
    expect(clientB.events.map(({ payload, seq }) => ({ tabId: payload[0], seq }))).toEqual([
      { tabId: 'tab-b', seq: 1 },
    ])
    expect(server.getSeqWatermark('ws:a')['normalized-event']).toBe(2)
    expect(server.getSeqWatermark('ws:b')['normalized-event']).toBe(1)
  })

  test('retains only the disconnected client’s targeted events for resume', () => {
    const server = new SolusServer()
    const firstConnection = captureClient(server, 'ws:a')
    server.sendTargeted('ws:a', 'normalized-event', 'tab-a', { type: 'text_chunk', text: 'seen' })
    firstConnection.unsubscribe()

    expect(server.sendTargeted(
      'ws:a',
      'normalized-event',
      'tab-a',
      { type: 'text_chunk', text: 'during reconnect' },
    )).toBe(false)
    server.sendTargeted('ws:b', 'normalized-event', 'tab-b', { type: 'text_chunk', text: 'other client' })

    const replay = server.replayFrom('normalized-event', 1, 'ws:a')
    expect(replay?.map(({ seq, payload }) => ({ seq, tabId: payload[0], text: (payload[1] as { text: string }).text }))).toEqual([
      { seq: 2, tabId: 'tab-a', text: 'during reconnect' },
    ])
    expect(server.replayFrom('normalized-event', 0, 'ws:b')?.map(({ payload }) => payload[0])).toEqual(['tab-b'])
  })

  test('replays a targeted topic’s first event even when the client has no watermark for it', () => {
    const server = new SolusServer()
    server.broadcast('tasks-changed', { project: 'unseen global history' })
    server.sendTargeted('ws:a', 'normalized-event', 'tab-a', { type: 'text_chunk', text: 'first while away' })
    server.sendTargeted('ws:a', 'enriched-error', 'tab-a', { message: 'first error while away' })

    const replay = server.replayForResume('ws:a', {})

    expect(replay?.map(({ topic, events }) => ({
      topic,
      seqs: events.map(({ seq }) => seq),
      tabIds: events.map(({ payload }) => payload[0]),
    }))).toEqual([
      { topic: 'normalized-event', seqs: [1], tabIds: ['tab-a'] },
      { topic: 'enriched-error', seqs: [1], tabIds: ['tab-a'] },
    ])
    expect(replay?.some(({ topic }) => topic === 'tasks-changed')).toBe(false)
  })

  test('keeps global topic replay shared while targeted replay stays client-scoped', () => {
    const server = new SolusServer()
    server.broadcast('tasks-changed', { project: 'shared' })
    server.sendTargeted('ws:a', 'enriched-error', 'tab-a', { message: 'A failed' })
    server.sendTargeted('ws:b', 'enriched-error', 'tab-b', { message: 'B failed' })

    expect(server.replayFrom('tasks-changed', 0, 'ws:a')?.map(({ seq }) => seq)).toEqual([1])
    expect(server.replayFrom('tasks-changed', 0, 'ws:b')?.map(({ seq }) => seq)).toEqual([1])
    expect(server.replayFrom('enriched-error', 0, 'ws:a')?.map(({ payload }) => payload[0])).toEqual(['tab-a'])
    expect(server.replayFrom('enriched-error', 0, 'ws:b')?.map(({ payload }) => payload[0])).toEqual(['tab-b'])
  })

  test('requests a fresh snapshot when the client sequence belongs to an older server stream', () => {
    const server = new SolusServer()

    expect(server.replayFrom('normalized-event', 12, 'ws:a')).toBeNull()
    expect(server.replayFrom('tasks-changed', 12, 'ws:a')).toBeNull()
  })

  test('restores the older socket if an overlapping reconnect closes first', () => {
    const server = new SolusServer()
    const older = captureClient(server, 'ws:a')
    const replacement = captureClient(server, 'ws:a')

    server.sendTargeted('ws:a', 'normalized-event', 'tab-a', { type: 'text_chunk', text: 'new socket' })
    replacement.unsubscribe()
    server.sendTargeted('ws:a', 'normalized-event', 'tab-a', { type: 'text_chunk', text: 'old socket restored' })

    expect(replacement.events.map(({ seq }) => seq)).toEqual([1])
    expect(older.events.map(({ seq }) => seq)).toEqual([2])
  })
})
