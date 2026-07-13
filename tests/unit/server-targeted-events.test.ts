import { describe, expect, test } from 'bun:test'
import { SolusServer } from '../../src/main/server/server'
import type { RpcTopic } from '../../src/shared/rpc'

interface ReceivedEvent {
  topic: RpcTopic
  payload: unknown[]
}

function captureClient(server: SolusServer, clientId: string): {
  events: ReceivedEvent[]
  unsubscribe: () => void
} {
  const events: ReceivedEvent[] = []
  const unsubscribe = server.registerDirectClient(clientId, (topic, payload) => {
    events.push({ topic, payload })
  })
  return { events, unsubscribe }
}

// Sequencing and reconnect replay are owned by the WebSocket transport's
// per-client stream (see transports/websocket.ts and client-core tests); the
// server's job is only that a tab-scoped event never leaks to another client.
describe('SolusServer targeted event routing', () => {
  test('delivers each tab event only to its owning client', () => {
    const server = new SolusServer()
    const clientA = captureClient(server, 'ws:a')
    const clientB = captureClient(server, 'ws:b')

    server.sendTargeted('ws:a', 'normalized-event', 'tab-a', { type: 'assistant_message', text: 'A' })
    server.sendTargeted('ws:b', 'normalized-event', 'tab-b', { type: 'assistant_message', text: 'B' })
    server.sendTargeted('ws:a', 'normalized-event', 'tab-a', { type: 'task_complete' })

    expect(clientA.events.map(({ payload }) => payload[0])).toEqual(['tab-a', 'tab-a'])
    expect(clientB.events.map(({ payload }) => payload[0])).toEqual(['tab-b'])
  })

  test('reports undeliverable when the client has no registration', () => {
    const server = new SolusServer()
    const client = captureClient(server, 'ws:a')
    client.unsubscribe()

    expect(server.sendTargeted('ws:a', 'normalized-event', 'tab-a', { type: 'text_chunk', text: 'gone' })).toBe(false)
  })

  test('routes to the newest registration and restores the older one when it drops', () => {
    const server = new SolusServer()
    const older = captureClient(server, 'ws:a')
    const replacement = captureClient(server, 'ws:a')

    server.sendTargeted('ws:a', 'normalized-event', 'tab-a', { type: 'text_chunk', text: 'new socket' })
    replacement.unsubscribe()
    server.sendTargeted('ws:a', 'normalized-event', 'tab-a', { type: 'text_chunk', text: 'old socket restored' })

    expect(replacement.events.map(({ payload }) => (payload[1] as { text: string }).text)).toEqual(['new socket'])
    expect(older.events.map(({ payload }) => (payload[1] as { text: string }).text)).toEqual(['old socket restored'])
  })
})
