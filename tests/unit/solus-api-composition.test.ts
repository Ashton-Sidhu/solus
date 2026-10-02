import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { isRecordServicePath } from '@solus/contracts/solus-api/routes'
import { resetTestDatabase } from './helpers/test-db'

// WHY: the cloud application (plans/013) serves the record service and the account
// site behind one listener. The record service must run on a server it does not own,
// answer only the paths the shared route contract gives it, and release everything
// it opened, after a successful boot and after a failed one.

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))
const environment = ['SOLUS_DATA_DIR', 'SOLUS_API', 'SOLUS_DB', 'DATABASE_URL', 'SOLUS_CLOUD_ISSUER', 'SOLUS_CLOUD_JWKS_URL', 'SOLUS_API_SIGNING_KEY'] as const
const previous = environment.map(key => [key, process.env[key]] as const)
type ServiceModule = typeof import('@solus/server/boot-solus-api')
let api: ServiceModule
let directory: string

function useSqlite(): void {
  delete process.env.DATABASE_URL
  process.env.SOLUS_DB = 'sqlite'
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'solus-api-composition-'))
  Object.assign(process.env, { SOLUS_DATA_DIR: directory, SOLUS_API: '1',
    SOLUS_CLOUD_ISSUER: 'https://issuer.example.test', SOLUS_CLOUD_JWKS_URL: 'https://issuer.example.test/jwks',
    SOLUS_API_SIGNING_KEY: Buffer.alloc(32, 13).toString('base64') })
  useSqlite()
  api = await import('@solus/server/boot-solus-api')
})
afterAll(async () => {
  await resetTestDatabase()
  for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  rmSync(directory, { recursive: true, force: true })
})

/** A listener the test owns: record paths go to the service, everything else is the site's. */
async function listenComposed(service: Awaited<ReturnType<ServiceModule['createSolusApiService']>>): Promise<{ http: Server; url: string }> {
  const http = createServer((request, response) => {
    if (isRecordServicePath(new URL(request.url ?? '/', 'http://composed.test').pathname)) return service.requestListener(request, response)
    response.writeHead(418, { 'content-type': 'text/plain' }).end('site')
  })
  service.attachLiveTransport(http)
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  return { http, url: `http://127.0.0.1:${address.port}` }
}

test('the record service answers its own paths on a listener it does not own, and starts no execution', async () => {
  let port = 0
  const service = await api.createSolusApiService({ host: '127.0.0.1', port: () => port })
  const { http, url } = await listenComposed(service)
  port = Number(new URL(url).port)
  try {
    expect((await fetch(url + '/v1/openapi.json')).status).toBe(200)
    // Bearer admission still guards records: no credential, no tasks.
    expect((await fetch(url + '/v1/tasks')).status).toBe(401)
    expect((await fetch(url + '/health')).status).toBe(200)
    // The site's paths never reach the record service.
    expect(await (await fetch(url + '/account')).text()).toBe('site')
    // Engine.IO answers `/ws` before either handler: an unauthenticated poll is refused by the transport, not served as a page.
    const poll = await fetch(url + '/ws/?EIO=4&transport=polling')
    expect(poll.status).not.toBe(418)
    expect(poll.status).not.toBe(404)
    expect(service.server.hasHandler('prompt')).toBe(false)
    expect(service.server.hasHandler('automationRun')).toBe(false)
    expect(service.server.hasHandler('sharedSessionPrompt')).toBe(true)
  } finally {
    service.closeLiveTransport()
    await new Promise<void>(resolve => http.close(() => resolve()))
    await service.close()
  }
  // Close is idempotent, and a closed transport cannot be attached again.
  await service.close()
  expect(() => service.attachLiveTransport(createServer())).toThrow()
})

test('every route the record service registers is a record path, or one only its own listener serves', async () => {
  // These answer only in standalone API mode, where the service owns its listener. In
  // the cloud application they are the site's: pairing does not exist in API mode, and
  // the integration callbacks are the account site's.
  const ownListenerOnly = new Set(['/endpoints', '/pair', '/pair/open', '/upload', '/voice/transcribe', '/artifact', '/oauth/google/callback', '/oauth/atlassian/callback'])
  const service = await api.createSolusApiService({ host: '127.0.0.1', port: () => 0 })
  try {
    // `ALL <path>/*` entries are middleware (CORS, the static fallback), not routes.
    const routes = service.routes.filter(route => !(route.method === 'ALL' && route.path.endsWith('*')))
    expect(routes.some(route => route.path === '/v1/tasks/:taskId')).toBe(true)
    const unowned = routes
      .map(route => route.path.replace(/:[^/]+/g, 'x'))
      .filter(path => !isRecordServicePath(path) && !ownListenerOnly.has(path))
    expect(unowned).toEqual([])
  } finally {
    await service.close()
  }
})

test('a failed boot releases the database it opened, so the next boot starts clean', async () => {
  process.env.SOLUS_DB = 'postgres'
  process.env.DATABASE_URL = 'postgres://solus@127.0.0.1:1/unreachable'
  await expect(api.createSolusApiService({ host: '127.0.0.1', port: () => 0 })).rejects.toThrow()
  // Had the failed Postgres stayed open, this boot would reuse it and fail too.
  useSqlite()
  const service = await api.createSolusApiService({ host: '127.0.0.1', port: () => 0 })
  await service.close()
})

test('the standalone API mode still owns its listener and frees the port on shutdown', async () => {
  const booted = await api.bootSolusApi({ host: '127.0.0.1', port: 0 })
  const url = `http://127.0.0.1:${booted.port}`
  expect((await fetch(url + '/v1/openapi.json')).status).toBe(200)
  await Promise.all([booted.shutdown(), booted.shutdown()])
  await expect(fetch(url + '/health')).rejects.toThrow()
  const rebound = createServer()
  await new Promise<void>((resolve, reject) => { rebound.once('error', reject); rebound.listen(booted.port, '127.0.0.1', resolve) })
  await new Promise<void>(resolve => rebound.close(() => resolve()))
})
