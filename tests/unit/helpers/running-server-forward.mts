import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { runningServer } from '../running-server-fixtures'
import { ServerForwards } from '../../../apps/desktop/src/main/server-forwards'
import { RunningServerTunnels } from '../../../packages/server/src/host/running-servers/tunnel'

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test port')
  return address.port
}
async function close(server: Server): Promise<void> {
  const done = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  server.closeAllConnections()
  await done
}

const upstream = createServer((request, response) => { response.writeHead(401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ path: request.url })) })
const echo = new WebSocketServer({ server: upstream })
echo.on('connection', (socket) => socket.on('message', (message) => socket.send(message)))
const upstreamPort = await listen(upstream)
const target = runningServer()
target.endpoints[0] = { endpointId: 'api', address: '127.0.0.1', port: upstreamPort, url: `http://127.0.0.1:${upstreamPort}/admin?api=v1#health`, response: null }
const tunnels = new RunningServerTunnels({ list: async () => [target], identityMatches: async () => true })
const host = createServer((_request, response) => { response.writeHead(404); response.end() })
host.on('upgrade', (request, socket, head) => { if (!tunnels.handleUpgrade(request, socket, head)) socket.destroy() })
const hostPort = await listen(host)
const forwards = new ServerForwards()
try {
  const ticket = await tunnels.issue('desktop', target.serverId, 'api')
  const request = { endpointKey: 'host:server:api', tunnelUrl: `ws://127.0.0.1:${hostPort}${ticket.relativeUrl}`, targetUrl: target.endpoints[0].url, expiresAt: ticket.expiresAt }
  const forward = await forwards.start(request)
  const response = await fetch(forward.url)
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { path: '/admin?api=v1' })
  assert.ok(forward.url.endsWith('/admin?api=v1#health'))
  assert.equal((await forwards.start(request)).localPort, forward.localPort)
  assert.equal(forwards.list().length, 1)
  const socket = new WebSocket(forward.url.replace(/^http/, 'ws').split('#')[0])
  await once(socket, 'open')
  socket.send('HMR and API WebSockets')
  const [message] = await once(socket, 'message')
  assert.equal(message.toString(), 'HMR and API WebSockets')
  const closed = once(socket, 'close')
  socket.close()
  await closed
  forwards.stop(forward.forwardId)
  assert.deepEqual(forwards.list(), [])
  tunnels.disconnect('desktop')
  const denied = new WebSocket(request.tunnelUrl)
  denied.on('error', () => {})
  const [, rejection] = await once(denied, 'unexpected-response')
  assert.equal(rejection.statusCode, 403)
  rejection.destroy()
  denied.terminate()
} finally {
  forwards.close()
  tunnels.close()
  for (const socket of echo.clients) socket.terminate()
  echo.close()
  await close(host)
  await close(upstream)
}
