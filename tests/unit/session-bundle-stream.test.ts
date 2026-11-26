import { afterAll, afterEach, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionRepositoryBundleResult } from '@solus/contracts/rpc'
import type { RemoteHost, RemoteHosts } from '@solus/server/execution/orchestration/remote-hosts'

mock.module('node:sqlite', () => ({ DatabaseSync }))
mock.module('@solus/server/project-config/projects-manifest', () => ({ listProjects: async () => [] }))

const root = mkdtempSync(join(tmpdir(), 'solus-bundle-stream-test-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
process.env.SOLUS_DATA_DIR = root
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const { SessionRepositories, sessionRepositoryName } = await import('@solus/server/sync/sessions/session-repository')
const { SessionBundleTransfers } = await import('@solus/server/sync/sessions/session-bundle-transfers')
const { buildHttpServer } = await import('@solus/server/transport/http')
const { fetchSessionBundle } = await import('@solus/server/execution/sessions/session-bundle-source')
const { HOST_ACTOR } = await import('@solus/server/admission/actor')

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected TCP address')
  return `http://127.0.0.1:${address.port}`
}

let sequence = 0
/** A source repository with one 2 MiB turn, and the transfers that serve it. */
async function sourceRepository() {
  const name = `stream-${++sequence}`
  const repositories = new SessionRepositories(join(root, name))
  const repository = sessionRepositoryName('local', name)
  const payload = join(root, `${name}.bin`)
  writeFileSync(payload, randomBytes(2 * 1024 * 1024))
  const head = await repositories.named(repository).commit({ expectedHead: null, message: 'turn', entries: [{ path: 'threads/thread/main/0', file: payload }] })
  const transfers = new SessionBundleTransfers(repositories)
  const start = async () => {
    const started = await transfers.start(name, repository, null, 'person-one')
    if (started.state !== 'ready' || !started.downloadSecret) throw new Error('expected a ready transfer with a download secret')
    return { ...started, downloadSecret: started.downloadSecret }
  }
  return { name, repository, head, transfers, start }
}

async function get(url: string, headers: Record<string, string>): Promise<Response> {
  return fetch(url, { headers })
}

async function refusedSoon(url: string, secret: string): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await get(url, { authorization: `Bearer ${secret}` })
    await response.body?.cancel()
    if (response.status === 401) return 401
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return 0
}

// WHY: the stream sends full provider transcripts. Only the holder of the one
// download secret gets them, and the secret ends with the transfer.
test('the bundle route refuses a wrong secret, serves the stream and a Range, and refuses the secret after the transfer', async () => {
  const source = await sourceRepository()
  const base = await listen(buildHttpServer({ host: '127.0.0.1', port: 0, sessionBundles: source.transfers }).server)
  try {
    const full = await source.start()
    const url = `${base}/session-bundles/${full.transferId}`
    expect((await get(url, {})).status).toBe(401)
    expect((await get(url, { authorization: 'Bearer wrong-secret' })).status).toBe(401)
    expect((await get(`${base}/session-bundles/${crypto.randomUUID()}`, { authorization: `Bearer ${full.downloadSecret}` })).status).toBe(401)

    const response = await get(url, { authorization: `Bearer ${full.downloadSecret}` })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(full.size))
    const bytes = Buffer.from(await response.arrayBuffer())
    expect(bytes.length).toBe(full.size)
    const received = join(root, `${source.name}-received.bundle`)
    writeFileSync(received, bytes)
    const target = new SessionRepositories(join(root, `${source.name}-target`))
    expect(await target.named(source.repository).fetchBundle(received)).toBe(source.head)
    expect(await refusedSoon(url, full.downloadSecret)).toBe(401)

    const ranged = await source.start()
    const rangedUrl = `${base}/session-bundles/${ranged.transferId}`
    const secret = { authorization: `Bearer ${ranged.downloadSecret}` }
    expect((await get(rangedUrl, { ...secret, range: `bytes=${ranged.size}-` })).status).toBe(416)
    expect((await get(rangedUrl, { ...secret, range: 'bytes=0-10' })).status).toBe(416)
    const partial = await get(rangedUrl, { ...secret, range: 'bytes=1000-' })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe(`bytes 1000-${ranged.size - 1}/${ranged.size}`)
    expect(Buffer.from(await partial.arrayBuffer()).equals(bytes.subarray(1000))).toBe(true)
    expect(await refusedSoon(rangedUrl, ranged.downloadSecret)).toBe(401)
  } finally {
    await source.transfers.stop()
  }
})

/** Host B's view of Host A: the RPC answers from real transfers, and HTTP at `httpUrl`. */
function hostsFor(answer: SessionRepositoryBundleResult, httpUrl: string, transfers: InstanceType<typeof SessionBundleTransfers>, chunkCalls: { count: number }): RemoteHosts {
  const remote = {
    hostId: 'host-a', installationId: 'host-a', label: 'Host A',
    call: (_what: string, request: () => Promise<unknown>) => request(),
    httpUrl: () => httpUrl,
    api: {
      sessionRepositoryBundle: async () => answer,
      sessionRepositoryBundleChunk: async ({ transferId, offset }: { transferId: string; offset: number }) => {
        chunkCalls.count++
        return transfers.chunk(transferId, offset, 'person-one')
      },
    },
  } as unknown as RemoteHost
  return { find: async () => remote, connect: () => remote } as unknown as RemoteHosts
}

async function fetchInto(hosts: RemoteHosts, name: string): Promise<string> {
  const outFile = join(root, `${name}-${++sequence}.bundle`)
  const result = await fetchSessionBundle(hosts, { account: null, isOwner: true }, { sessionId: name, have: null, wantedHead: null, sourceHostId: 'host-a', outFile, signal: new AbortController().signal, actor: HOST_ACTOR })
  expect(result.state).toBe('ready')
  return outFile
}

// WHY: an older host has no stream route. Host B must still get the bundle from it.
test('Host B uses the chunk RPC when the host has no bundle route', async () => {
  const source = await sourceRepository()
  const older = await listen(createServer((_request, response) => { response.writeHead(404).end('{"error":"not found"}') }))
  // An older host that serves the web client answers an unknown path with its page.
  const withClient = await listen(createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html>') }))
  try {
    for (const httpUrl of [older, withClient]) {
      const answer = await source.start()
      const chunkCalls = { count: 0 }
      const outFile = await fetchInto(hostsFor(answer, httpUrl, source.transfers, chunkCalls), source.name)
      expect(chunkCalls.count).toBeGreaterThan(0)
      const target = new SessionRepositories(join(root, `${source.name}-target-${sequence}`))
      expect(await target.named(source.repository).fetchBundle(outFile)).toBe(source.head)
    }
  } finally {
    await source.transfers.stop()
  }
})

// WHY: a large bundle on a weak connection must not start again from byte 0
// each time the stream drops.
test('Host B continues a dropped stream with a Range from its last byte', async () => {
  const source = await sourceRepository()
  const answer = await source.start()
  const bundle = Buffer.from(await (await fetch(`${await listen(buildHttpServer({ host: '127.0.0.1', port: 0, sessionBundles: source.transfers }).server)}/session-bundles/${answer.transferId}`, { headers: { authorization: `Bearer ${answer.downloadSecret}` } })).arrayBuffer())
  const requests: { range: string | undefined; authorization: string | undefined }[] = []
  const half = Math.floor(bundle.length / 2)
  const flaky = await listen(createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push({ range: request.headers.range, authorization: request.headers.authorization })
    if (requests.length === 1) {
      response.writeHead(200, { 'content-type': 'application/x-git-bundle', 'content-length': String(bundle.length) })
      response.write(bundle.subarray(0, half), () => response.socket?.destroy())
      return
    }
    const start = Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? '')?.[1] ?? Number.NaN)
    response.writeHead(206, { 'content-type': 'application/x-git-bundle', 'content-length': String(bundle.length - start), 'content-range': `bytes ${start}-${bundle.length - 1}/${bundle.length}` })
    response.end(bundle.subarray(start))
  }))
  try {
    const chunkCalls = { count: 0 }
    const outFile = await fetchInto(hostsFor(answer, flaky, source.transfers, chunkCalls), source.name)
    expect(chunkCalls.count).toBe(0)
    expect(requests).toHaveLength(2)
    expect(requests.every(({ authorization }) => authorization === `Bearer ${answer.downloadSecret}`)).toBe(true)
    expect(requests[0]!.range).toBeUndefined()
    const resumedAt = Number(/^bytes=(\d+)-$/.exec(requests[1]!.range ?? '')?.[1])
    expect(resumedAt).toBeGreaterThan(0)
    expect(resumedAt).toBeLessThanOrEqual(half)
    expect(readFileSync(outFile).equals(bundle)).toBe(true)
  } finally {
    await source.transfers.stop()
  }
})
