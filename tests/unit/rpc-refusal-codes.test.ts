import { afterAll, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { createServer } from 'node:http'
import { dialHostSocket } from '@solus/client-core/host-socket'

mock.module('node:sqlite', () => ({ DatabaseSync }))

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
// (verify-multiplayer TRIAGE: a member changing a share link on a managed host, a
// task's share link). A share rule's refusal carries its code on the wire, as an
// access-policy refusal does.
test('a share rule\'s refusal reaches the client with its code', async () => {
  server.register('shareSetLink', () => {
    throw new ShareAccessError('FORBIDDEN', 'Only the owner can change the link')
  })
  // The server is credential-free (`requireAuth: false`), so the handshake carries no credential.
  const dialed = await dialHostSocket(url, {})
  if (!dialed.ok) throw new Error(dialed.message)
  try {
    const envelope = await dialed.socket.call('shareSetLink', [{ resource: { kind: 'work', id: 'w1' }, link: null }])
    expect(envelope.error).toEqual({ message: 'Only the owner can change the link', code: 'FORBIDDEN' })
  } finally {
    dialed.socket.close()
  }
})
