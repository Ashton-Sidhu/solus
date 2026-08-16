import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Server } from 'http'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'

// bun has no node:sqlite; the http module's import chain reaches the db even
// though these tests never open it. Same seam pinned-sessions.test.ts uses.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const { buildHttpServer } = await import('../../src/main/server/http')
type HttpServerOptions = NonNullable<Parameters<typeof buildHttpServer>[0]>
const auth = await import('../../src/main/server/auth')

// The web client connects to its serving origin with no pairing ceremony only
// when /health explicitly advertises `requireAuth: false`. These tests pin the
// two sides of that contract: the server reports its real bind policy, and a
// server that never states one reads as locked — never as open.
describe('/health auth advertisement', () => {
  const originalDataDir = process.env.SOLUS_DATA_DIR
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'solus-health-test-'))
    process.env.SOLUS_DATA_DIR = dataDir
    auth.resetAuthStateForTests()
  })

  afterEach(() => {
    auth.resetAuthStateForTests()
    rmSync(dataDir, { recursive: true, force: true })
    if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
    else process.env.SOLUS_DATA_DIR = originalDataDir
  })

  test('advertises an open server so the served client may connect silently', async () => {
    const { server, baseUrl } = await listen({ requireAuth: () => false })
    try {
      const health = await getJson(`${baseUrl}/health`)
      expect(health.status).toBe(200)
      expect(health.body.requireAuth).toBe(false)
    } finally {
      await close(server)
    }
  })

  test('a server with no stated policy reads as locked, not open', async () => {
    const { server, baseUrl } = await listen({})
    try {
      const health = await getJson(`${baseUrl}/health`)
      expect(health.status).toBe(200)
      expect(health.body.requireAuth).toBe(true)
    } finally {
      await close(server)
    }
  })

  test('a require-auth bind still advertises open to a trusted requester', async () => {
    // The bind policy is per-server, but trust is per-caller: the machine
    // itself and the host's own tailnet skip pairing even on a locked bind.
    const { server, baseUrl } = await listen({
      requireAuth: () => true,
      isTrustedRequester: async () => true,
    })
    try {
      const health = await getJson(`${baseUrl}/health`)
      expect(health.body.requireAuth).toBe(false)
    } finally {
      await close(server)
    }
  })

  test('an untrusted requester on a require-auth bind stays locked', async () => {
    const { server, baseUrl } = await listen({
      requireAuth: () => true,
      isTrustedRequester: async () => false,
    })
    try {
      const health = await getJson(`${baseUrl}/health`)
      expect(health.body.requireAuth).toBe(true)
    } finally {
      await close(server)
    }
  })
})

async function listen(opts: Pick<HttpServerOptions, 'requireAuth' | 'isTrustedRequester'>): Promise<{ server: Server; baseUrl: string }> {
  const { server } = buildHttpServer({ host: '127.0.0.1', port: 0, ...opts })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind to a TCP port')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const response = await fetch(url)
  return { status: response.status, body: await response.json() }
}
