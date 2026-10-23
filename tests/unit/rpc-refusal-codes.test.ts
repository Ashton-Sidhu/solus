import { afterAll, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { io } from 'socket.io-client'
import { SOLUS_PROTOCOL } from '@solus/contracts/uplink'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const { SolusServer } = await import('@solus/server/transport/server')
const { ClientEventRegistry } = await import('@solus/server/transport/events/client-event-registry')
const { attachWebSocketTransport } = await import('@solus/server/transport/websocket')
const { ShareAccessError } = await import('@solus/server/sharing/share-manager')

const http = createServer()
const server = new SolusServer()
const transport = attachWebSocketTransport(http, server, { clientEvents: new ClientEventRegistry(), requireAuth: false })
await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
const address = http.address()
const url = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`

afterAll(() => { transport.close(); http.close() })

// WHY: a client tells "you may not" from "it failed" by the code, on every refusal
// (verify-multiplayer TRIAGE: a member's ownership transfer on a managed host, a
// task's share link). A share rule's refusal carries its code on the wire, as an
// access-policy refusal does.
test('a share rule\'s refusal reaches the client with its code', async () => {
  server.register('shareTransfer', () => {
    throw new ShareAccessError('FORBIDDEN', 'Only the owner can transfer ownership')
  })
  // The server is credential-free (`requireAuth: false`), so the handshake names only the protocol it speaks.
  const socket = io(url, { path: '/ws', transports: ['websocket'], reconnection: false, auth: { protocol: SOLUS_PROTOCOL } })
  try {
    await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('connect_error', reject) })
    const envelope = await new Promise<{ error?: { message: string; code?: string } }>((resolve) => {
      socket.emit('rpc', randomUUID(), 'shareTransfer', [{ resource: { kind: 'work', id: 'w1' }, toUserId: 'bob' }], resolve)
    })
    expect(envelope.error).toEqual({ message: 'Only the owner can transfer ownership', code: 'FORBIDDEN' })
  } finally {
    socket.close()
  }
})
