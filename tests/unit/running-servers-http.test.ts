import { describe, expect, mock, test } from 'bun:test'
import { createServer, type RequestListener } from 'node:http'
import { DatabaseSync } from './helpers/bun-sqlite'
import { runningServer, serverModel } from './running-server-fixtures'
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { probeHttpServer } = await import('@solus/server/host/running-servers/probe')

async function withServer(handler: RequestListener, check: (port: number) => Promise<void>): Promise<void> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No test port')
    await check(address.port)
  } finally {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    server.closeAllConnections()
    await closed
  }
}

describe('HTTP server discovery includes APIs', () => {
  for (const status of [200, 401, 404, 500]) {
    test(`JSON status ${status} is a server, even when the root route fails`, async () => {
      await withServer((_request, response) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end('{"message":"API"}')
      }, async (port) => {
        const result = await probeHttpServer(port)
        expect(result).toEqual({ kind: 'http', protocol: 'http', response: { protocol: 'http', statusCode: status, contentType: 'application/json', pageTitle: null } })
      })
    })
  }

  test('an empty response without a content type is still HTTP', async () => {
    await withServer((_request, response) => { response.writeHead(204); response.end() }, async (port) => {
      const result = await probeHttpServer(port)
      expect(result.kind).toBe('http')
      if (result.kind === 'http') expect(result.response.contentType).toBeNull()
    })
  })

  test('HTML retains its title for browser targets', async () => {
    await withServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<title>Dashboard</title>') }, async (port) => {
      const result = await probeHttpServer(port)
      if (result.kind !== 'http') throw new Error('Expected HTTP')
      expect(result.response.pageTitle).toBe('Dashboard')
    })
  })

  test('redirects are reported without probing a different service', async () => {
    await withServer((_request, response) => { response.writeHead(302, { location: 'https://example.invalid/private' }); response.end() }, async (port) => {
      const result = await probeHttpServer(port)
      if (result.kind !== 'http') throw new Error('Expected HTTP')
      expect(result.response.statusCode).toBe(302)
    })
  })
})

test('checkout grouping does not confuse the starting session with location', () => {
  const first = runningServer()
  const second = runningServer('second')
  second.startedBy = { kind: 'agent', sessionId: 'other-session' }
  const other = runningServer('other-checkout')
  other.location.worktreePath = '/project/worktree-two'
  expect([first, second, other].filter((data) => serverModel(data).matchesCheckout('/project/worktree/'))).toEqual([first, second])
  expect(new Set([first, second, other].map((data) => serverModel(data).checkoutPath)).size).toBe(2)
  expect(serverModel(first).endpointLabel(first.endpoints[0])).toBe(':3001 · JSON')
})

test('a session subfolder selects its checkout and excludes sibling and nested worktrees', () => {
  const main = runningServer('main')
  main.location.worktreePath = '/project'
  const nested = runningServer('nested')
  nested.location.worktreePath = '/project/.worktrees/feature'
  const sibling = runningServer('sibling')
  sibling.location.worktreePath = '/project/.worktrees/feature-two'
  expect([main, nested, sibling].filter((data) => serverModel(data).matchesCheckout('/project/.worktrees/feature/api', '/project/.worktrees/feature'))).toEqual([nested])
  expect([main, nested, sibling].filter((data) => serverModel(data).matchesCheckout('/project/api', '/project'))).toEqual([main])
  nested.location.worktreePath = 'C:\\Project\\feature'
  expect([nested].filter((data) => serverModel(data).matchesCheckout('c:/project/feature/api', 'C:/Project/feature'))).toEqual([nested])
})
