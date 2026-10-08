import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WsTransport } from '@solus/client-core/ws-transport'
import { SolusApp } from '../../apps/mobile/src/app/solus-app'
import { memoryKeyValueStore, memorySecretStore } from '../../apps/mobile/src/platform/ports'

/**
 * Plan 017 stage 0, step 4: the native composition against a disposable host
 * over a real socket. Pairing over `/pair`, one typed RPC, one event
 * subscription, and one record HTTP read. No live data or token is used.
 */

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const previousDataDir = process.env.SOLUS_DATA_DIR
process.env.SOLUS_DATA_DIR = join(mkdtempSync(join(tmpdir(), 'solus-native-host-')), 'data')

const INSTALLATION_ID = 'inst-native-test'
const PAIR_CODE = 'PAIR42'
let http: HttpServer | null = null
let url = ''
let closeTransport: () => void = () => {}
let publishToAll: (sessionId: string, text: string) => Promise<number> = async () => 0
const pairedLabels: string[] = []
const recordReads: string[] = []

async function readBody(request: IncomingMessage): Promise<string> {
  let body = ''
  for await (const chunk of request) body += String(chunk)
  return body
}

beforeAll(async () => {
  const auth = await import('@solus/server/admission/auth')
  const { SolusServer } = await import('@solus/server/transport/server')
  const { ClientEventRegistry } = await import('@solus/server/transport/events/client-event-registry')
  const { HostEventPublisher } = await import('@solus/server/transport/events/host-event-publisher')
  const { attachWebSocketTransport } = await import('@solus/server/transport/websocket')

  const sessionTokens = new Set<string>()
  http = createServer(async (request, response) => {
    const json = (status: number, body: object) => {
      response.statusCode = status
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(body))
    }
    const bearer = request.headers.authorization?.replace(/^Bearer /, '') ?? ''
    if (request.method === 'GET' && request.url === '/health') return json(200, { ok: true, installationId: INSTALLATION_ID, name: 'Disposable host', os: 'linux' })
    if (request.method === 'POST' && request.url === '/pair') {
      const body = JSON.parse(await readBody(request)) as { pairToken: string; deviceLabel: string }
      if (body.pairToken !== PAIR_CODE) return json(401, { error: 'Invalid or expired pair token' })
      pairedLabels.push(body.deviceLabel)
      const { token } = auth.issueSessionToken(body.deviceLabel)
      sessionTokens.add(token)
      return json(200, { sessionToken: token, installationId: INSTALLATION_ID, os: 'linux' })
    }
    if (request.method === 'POST' && request.url === '/auth/ws-ticket') {
      const ticket = auth.issueWsTicket(bearer)
      return ticket ? json(200, { ticket }) : json(401, { error: 'unauthorized' })
    }
    if (request.method === 'POST' && request.url === '/v1/auth/session') {
      if (!sessionTokens.has(bearer)) return json(401, { error: { code: 'UNAUTHENTICATED', message: 'no' } })
      return json(200, {
        accessToken: 'records-token', tokenType: 'Bearer', expiresAt: new Date(Date.now() + 300_000).toISOString(),
        scopes: ['sessions:read'], home: { kind: 'local', hostId: INSTALLATION_ID },
        subject: { kind: 'user', userId: 'local:owner', displayName: 'Owner', sessionId: null },
      })
    }
    if (request.method === 'GET' && request.url?.startsWith('/v1/sessions')) {
      recordReads.push(request.url)
      if (bearer !== 'records-token') return json(401, { error: { code: 'UNAUTHENTICATED', message: 'no' } })
      return json(200, {
        items: [{
          id: 'thread-1', home: { kind: 'local', hostId: INSTALLATION_ID }, organizationId: null, ownerUserId: 'local:owner',
          version: 'v1', createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T11:00:00Z',
          provider: 'claude-code', title: 'Fix the build', customTitle: null, projectId: null, projectPath: '/work/app',
          projectRemote: null, runnerHostId: null, status: 'idle', model: null, reasoningEffort: null, parentSessionId: null,
          rootSessionId: null, publication: 'local', size: 10, cwd: '/work/app', slug: null, isWorktree: false, branch: null,
          projectRoot: '/work/app', delegation: null,
        }],
        nextCursor: null,
        indexing: false,
      })
    }
    response.statusCode = 404
    response.end()
  })
  const server = new SolusServer()
  server.register('listProjects', async () => [{ key: 'app', path: '/work/app', folderName: 'app', addedAt: '2026-10-01T00:00:00Z', lastUsedAt: '2026-10-01T00:00:00Z', repositoryKey: null }])
  const clientEvents = new ClientEventRegistry()
  const events = new HostEventPublisher(clientEvents)
  const transport = attachWebSocketTransport(http, server, { clientEvents, requireAuth: true })
  closeTransport = () => transport.close()
  publishToAll = (sessionId, text) => events.publish(clientEvents.routableClientIds(), 'session.eventReceived', { sessionId, event: { type: 'text_chunk', text } })
  const listening = http
  await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve))
  const address = listening.address()
  if (!address || typeof address === 'string') throw new Error('expected a TCP address')
  url = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  closeTransport()
  const server = http
  if (server) {
    // Keep-alive fetch connections would hold `close` open.
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  ;(await import('@solus/server/admission/auth')).resetAuthStateForTests()
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

function untilConnected(app: SolusApp, hostId: string): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (app.connections.state(hostId)?.phase !== 'connected') return
      stop()
      resolve()
    }
    const stop = app.connections.changes.subscribe(check)
    check()
  })
}

describe('native client against a disposable host', () => {
  test('pairs, calls a typed RPC, receives an event, and reads a record over HTTP', async () => {
    const app = new SolusApp({
      storage: memoryKeyValueStore(),
      secrets: memorySecretStore(),
      fetch: (input, init) => fetch(input, init),
      createTransport: (options) => new WsTransport(options),
      openBrowser: async () => {},
      deviceLabel: 'Solus for iPhone',
      uuid: () => 'uuid-test',
    })
    await app.load()

    const preview = await app.preview(url)
    expect(preview).toMatchObject({ kind: 'found', preview: { name: 'Disposable host', installationId: INSTALLATION_ID } })
    await expect(app.pair({ url }, 'WRONG')).rejects.toThrow('Invalid or expired pair token')
    const host = await app.pair({ url, name: 'Disposable host' }, PAIR_CODE)
    expect(host.id).toBe(INSTALLATION_ID)
    expect(pairedLabels).toEqual(['Solus for iPhone'])

    const connection = app.connections.connection(host.id)!
    await untilConnected(app, host.id)

    // One typed RPC.
    expect(await connection.api.listProjects()).toEqual([{ key: 'app', path: '/work/app', folderName: 'app', addedAt: '2026-10-01T00:00:00Z', lastUsedAt: '2026-10-01T00:00:00Z', repositoryKey: null }])

    // One event subscription, owned by this host's connection.
    const received = new Promise<string>((resolve) => {
      const stop = connection.events.subscribe('session.eventReceived', (payload) => {
        if (payload.event.type !== 'text_chunk') return
        stop()
        resolve(payload.event.text)
      })
    })
    expect(await publishToAll('thread-1', 'hello phone')).toBe(1)
    expect(await received).toBe('hello phone')

    // One record read over the host's HTTP API with the paired credential.
    await app.threads.load(host.id)
    expect(app.threads.threads().map((thread) => [thread.record.sessionId, thread.record.title])).toEqual([['thread-1', 'Fix the build']])
    expect(recordReads).toHaveLength(1)

    await app.registry.forget(host.id)
    expect(app.connections.state(host.id)).toBeNull()
  })
})
