import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createServer, type Server } from 'http'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { HOST_SOCKET_PATH, HOST_SOCKET_PROTOCOL_VERSION } from '@solus/contracts/host-socket'

// docs/plans/fast-secure-startup.md decision 4. A page the person visits runs on the
// same machine as the desktop's host, so a request from loopback proves nothing about
// who made it. Before this rule, any site could `POST http://127.0.0.1:3001/pair` with
// no code and read back an owner session token, or open an owner WebSocket: the owner
// runs agents, so that is code execution. Network position may stand in for a
// credential only for a request no page on another site could have made.

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { couldBeForgedByWebPage } = await import('@solus/server/transport/web-page-requests')
const { buildHttpServer } = await import('@solus/server/transport/http')
const auth = await import('@solus/server/admission/auth')
const { SolusServer } = await import('@solus/server/transport/server')
const { ClientEventRegistry } = await import('@solus/server/transport/events/client-event-registry')
const { attachWebSocketTransport } = await import('@solus/server/transport/websocket')

describe('couldBeForgedByWebPage', () => {
  test('a client that is no web page, on a name of this machine, is not forged', () => {
    for (const host of ['127.0.0.1:3001', '[::1]:3001', 'localhost:3001', '192.168.1.20:3001', '100.64.0.7:3001']) {
      expect(couldBeForgedByWebPage({ host })).toBe(false)
    }
  })

  test("the host's own page is not forged", () => {
    expect(couldBeForgedByWebPage({ host: '127.0.0.1:3001', origin: 'http://127.0.0.1:3001' })).toBe(false)
    expect(couldBeForgedByWebPage({ host: 'LOCALHOST:3001', origin: 'http://localhost:3001' })).toBe(false)
  })

  test('a page on another site is forged, whatever address it reaches', () => {
    expect(couldBeForgedByWebPage({ host: '127.0.0.1:3001', origin: 'https://evil.example' })).toBe(true)
    expect(couldBeForgedByWebPage({ host: '127.0.0.1:3001', origin: 'http://127.0.0.1:5174' })).toBe(true)
    expect(couldBeForgedByWebPage({ host: '127.0.0.1:3001', origin: 'null' })).toBe(true)
  })

  test('a DNS-rebound name is forged, even when its page is same-origin', () => {
    expect(couldBeForgedByWebPage({ host: 'evil.example:3001', origin: 'http://evil.example:3001' })).toBe(true)
    expect(couldBeForgedByWebPage({ host: 'evil.example:3001' })).toBe(true)
  })

  test('a request with no Host is forged', () => {
    expect(couldBeForgedByWebPage({})).toBe(true)
  })
})

describe('an open loopback host', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string
  const cleanups: Array<() => void> = []

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-web-page-requests-'))
    process.env.SOLUS_DATA_DIR = dataDir
    auth.resetAuthStateForTests()
  })

  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup()
    auth.resetAuthStateForTests()
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  async function listen(server: Server): Promise<string> {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    cleanups.push(() => server.close())
    return `http://127.0.0.1:${address.port}`
  }

  const pair = (baseUrl: string, origin?: string) => fetch(`${baseUrl}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify({ deviceLabel: 'test' }),
  })

  test('gives a session token without a code only to a request no page on another site could make', async () => {
    // The desktop's own host: loopback, auth off (SOLUS_REQUIRE_AUTH unset).
    const { server } = buildHttpServer({ host: '127.0.0.1', port: 0, requireAuth: () => false, isTrustedRequester: async () => true })
    const baseUrl = await listen(server)
    const fromAnotherSite = await pair(baseUrl, 'https://evil.example')
    expect(fromAnotherSite.status).toBe(401)
    expect(await fromAnotherSite.text()).not.toContain('sessionToken')
    const fromTheCli = await pair(baseUrl)
    expect(fromTheCli.status).toBe(200)
    expect((await fromTheCli.json()).sessionToken).toBeString()
    const fromItsOwnPage = await pair(baseUrl, baseUrl)
    expect(fromItsOwnPage.status).toBe(200)
  })

  /** Opens the host socket as a browser page would (its `Origin`), says hello with no credential, and answers the host's first frame. */
  function dial(url: string, origin?: string): Promise<string> {
    return new Promise((resolve) => {
      const socket = new WebSocket(`${url.replace(/^http/, 'ws')}${HOST_SOCKET_PATH}`, { headers: origin ? { origin } : {} })
      cleanups.push(() => socket.close())
      socket.onopen = () => socket.send(JSON.stringify({ t: 'hello', v: HOST_SOCKET_PROTOCOL_VERSION, clientInstanceId: 'test0123456789abcdef' }))
      socket.onmessage = (message) => {
        const frame = JSON.parse(String(message.data)) as { t: string; code?: string }
        if (frame.t === 'welcome') resolve('connected')
        else if (frame.t === 'refused') resolve(frame.code ?? 'refused')
      }
      socket.onerror = () => resolve('error')
    })
  }

  test('admits a socket with no credential as owner only when no page on another site could open it', async () => {
    const http = createServer()
    const transport = attachWebSocketTransport(http, new SolusServer(), {
      clientEvents: new ClientEventRegistry(),
      requireAuth: () => false,
      isTrustedRequester: async () => true,
    })
    cleanups.push(() => transport.close())
    const url = await listen(http)
    expect(await dial(url, 'https://evil.example')).toBe('UNAUTHORIZED')
    expect(await dial(url)).toBe('connected')
    expect(await dial(url, url)).toBe('connected')
  })
})
