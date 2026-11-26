import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { Server } from 'http'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { z } from 'zod'
import { PAIR_APPROVAL_MAX_OPEN, PAIR_APPROVAL_TTL_MS, type PairApprovalRequest } from '@solus/contracts/add-machine'
import type { HostEvent } from '@solus/contracts/host-events'
import type { Principal } from '@solus/server/admission/principal'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const { buildHttpServer } = await import('@solus/server/transport/http')
const auth = await import('@solus/server/admission/auth')
const { PairApprovals } = await import('@solus/server/admission/pair-approvals')
const { eventVisibleTo } = await import('@solus/server/sharing/event-audience')
const { requestPairApproval } = await import('@solus/client-core/pairing')

// An approval request lets a machine pair without a code, but only when an owner
// says yes, and only the machine that asked can collect the token.
const originalDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-pair-approvals-test-'))
  process.env.SOLUS_DATA_DIR = dataDir
  auth.resetAuthStateForTests()
})
afterEach(() => {
  auth.resetAuthStateForTests()
  rmSync(dataDir, { recursive: true, force: true })
  if (originalDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = originalDataDir
})

function clock(start = 1_000_000) {
  let now = start
  return { now: () => now, advance: (ms: number) => { now += ms } }
}

const ask = (approvals: InstanceType<typeof PairApprovals>, checkCode = 'K7QX-M2PA') =>
  approvals.start({ deviceLabel: 'Windows', checkCode, fromAddress: '10.0.0.7' })

describe('the open approval requests', () => {
  test('approval gives the requester a working token that is listed and revocable', async () => {
    const approvals = new PairApprovals()
    const old = auth.issueSessionToken('Windows (old)').token
    const started = approvals.start({ deviceLabel: 'Windows', checkCode: 'K7QX-M2PA', fromAddress: '10.0.0.7', replacesSessionToken: old })!
    expect(approvals.list().map((request) => request.checkCode)).toEqual(['K7QX-M2PA'])

    expect(approvals.decide(started.request.requestId, 'approve')).toBe(true)
    expect(approvals.list()).toEqual([])
    const outcome = await approvals.wait(started.request.requestId, started.waitToken)
    if (outcome.status !== 'approved') throw new Error(`expected approved, got ${outcome.status}`)

    const session = auth.verifySessionToken(outcome.granted)
    expect(session?.deviceLabel).toBe('Windows')
    expect(auth.listPairedDevices().find((device) => device.deviceId === session?.deviceId)?.revokedAt).toBeNull()
    // The token the device replaced no longer works.
    expect(auth.verifySessionToken(old)).toBeNull()
    auth.revokeDevice(session!.deviceId)
    expect(auth.verifySessionToken(outcome.granted)).toBeNull()
    // A result is read once.
    expect((await approvals.wait(started.request.requestId, started.waitToken)).status).toBe('expired')
  })

  test('a denied request issues nothing and cannot be decided again', async () => {
    const approvals = new PairApprovals()
    const started = ask(approvals)!
    expect(approvals.decide(started.request.requestId, 'deny')).toBe(true)
    expect(approvals.decide(started.request.requestId, 'approve')).toBe(false)
    expect(await approvals.wait(started.request.requestId, started.waitToken)).toEqual({ status: 'denied' })
    expect(auth.listPairedDevices()).toEqual([])
  })

  test('a request expires after five minutes and can no longer be approved', async () => {
    const time = clock()
    const approvals = new PairApprovals({ now: time.now })
    const heard: PairApprovalRequest[][] = []
    approvals.subscribe((open) => heard.push(open))
    const started = ask(approvals)!
    time.advance(PAIR_APPROVAL_TTL_MS)
    expect(approvals.list()).toEqual([])
    expect(heard.map((open) => open.length)).toEqual([1, 0])
    expect(approvals.decide(started.request.requestId, 'approve')).toBe(false)
    expect(await approvals.wait(started.request.requestId, started.waitToken)).toEqual({ status: 'expired' })
    expect(auth.listPairedDevices()).toEqual([])
  })

  test('a long poll answers pending when nobody decides in time', async () => {
    const approvals = new PairApprovals({ waitMs: 20 })
    const started = ask(approvals)!
    expect(await approvals.wait(started.request.requestId, started.waitToken)).toEqual({ status: 'pending' })
    // A decision wakes a waiting poll at once.
    const waiting = approvals.wait(started.request.requestId, started.waitToken)
    approvals.decide(started.request.requestId, 'deny')
    expect(await waiting).toEqual({ status: 'denied' })
  })

  test(`at most ${PAIR_APPROVAL_MAX_OPEN} requests are open`, () => {
    const approvals = new PairApprovals()
    const started = Array.from({ length: PAIR_APPROVAL_MAX_OPEN }, () => ask(approvals))
    expect(started.every(Boolean)).toBe(true)
    expect(ask(approvals)).toBeNull()
    // A decided request frees its place.
    approvals.decide(started[0]!.request.requestId, 'deny')
    expect(ask(approvals)).not.toBeNull()
  })

  test('a wrong wait token gets nothing and does not use up the result', async () => {
    const approvals = new PairApprovals()
    const started = ask(approvals)!
    approvals.decide(started.request.requestId, 'approve')
    expect(await approvals.wait(started.request.requestId, 'not-the-token')).toEqual({ status: 'expired' })
    expect((await approvals.wait(started.request.requestId, started.waitToken)).status).toBe('approved')
  })

  test('a token nobody collects is revoked', async () => {
    const time = clock()
    const approvals = new PairApprovals({ now: time.now })
    const started = ask(approvals)!
    approvals.decide(started.request.requestId, 'approve')
    const [device] = auth.listPairedDevices()
    expect(device?.revokedAt).toBeNull()
    time.advance(60_000)
    approvals.sweep()
    expect(auth.listPairedDevices()[0]?.revokedAt).not.toBeNull()
    expect((await approvals.wait(started.request.requestId, started.waitToken)).status).toBe('expired')
  })
})

describe('the approval routes', () => {
  const startBody = { deviceLabel: 'Windows', checkCode: 'k7qx m2pa' }

  test('a request, its approval, and the wait that collects the token', async () => {
    const approvals = new PairApprovals()
    const { server, baseUrl } = await listen({ pairApprovals: approvals })
    try {
      const start = await post(baseUrl, '/pair/request', startBody)
      expect(start.status).toBe(200)
      const started = z.object({ requestId: z.string(), expiresAt: z.number(), waitToken: z.string() }).strict().parse(start.body)
      // The host keeps the code the requester made, as the owner reads it.
      expect(approvals.list()[0]).toMatchObject({ checkCode: 'K7QX-M2PA', deviceLabel: 'Windows', fromAddress: '127.0.0.1' })
      approvals.decide(started.requestId, 'approve')
      const wait = await post(baseUrl, '/pair/request/wait', { requestId: started.requestId, waitToken: started.waitToken })
      const approved = z.object({ status: z.literal('approved'), sessionToken: z.string(), installationId: z.string(), identityKey: z.string().optional() }).parse(wait.body)
      expect(approved.installationId).toBe(auth.getInstallationId())
      expect(auth.verifySessionToken(approved.sessionToken)?.deviceLabel).toBe('Windows')
    } finally {
      await close(server)
    }
  })

  test('a check code that is not XXXX-XXXX is refused', async () => {
    const approvals = new PairApprovals()
    const { server, baseUrl } = await listen({ pairApprovals: approvals })
    try {
      expect((await post(baseUrl, '/pair/request', { deviceLabel: 'Windows', checkCode: 'K0QX-M2PA' })).status).toBe(400)
      expect(approvals.list()).toEqual([])
    } finally {
      await close(server)
    }
  })

  test('the sixth open request gets 429', async () => {
    const { server, baseUrl } = await listen({ pairApprovals: new PairApprovals() })
    try {
      for (let i = 0; i < PAIR_APPROVAL_MAX_OPEN; i++) expect((await post(baseUrl, '/pair/request', startBody)).status).toBe(200)
      expect((await post(baseUrl, '/pair/request', startBody)).status).toBe(429)
    } finally {
      await close(server)
    }
  })

  test('a cloud machine and the tunnel have no approval route', async () => {
    for (const exposure of [{ pairingDisabled: () => true }, { viaTunnel: true }]) {
      const approvals = new PairApprovals()
      const { server, baseUrl } = await listen({ pairApprovals: approvals, ...exposure })
      try {
        expect((await post(baseUrl, '/pair/request', startBody)).status).toBe(404)
        expect((await post(baseUrl, '/pair/request/wait', { requestId: 'x', waitToken: 'y' })).status).toBe(404)
        expect(approvals.list()).toEqual([])
      } finally {
        await close(server)
      }
    }
  })
})

describe('requestPairApproval', () => {
  const base = { url: 'http://10.0.0.2:3000', deviceLabel: 'Mac', checkCode: 'K7QX-M2PA' }
  const scripted = (answers: Array<{ status: number; body: unknown } | Error>) => {
    const paths: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      paths.push(new URL(String(url)).pathname)
      const answer = answers.shift()
      if (!answer) throw new Error('no more answers')
      if (answer instanceof Error) throw answer
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    return { paths, fetchImpl }
  }
  const started = { status: 200, body: { requestId: 'r1', expiresAt: 5, waitToken: 'w1' } }

  test('waits through pending until approved, and keeps the host as /pair does', async () => {
    const { paths, fetchImpl } = scripted([started, { status: 200, body: { status: 'pending' } }, { status: 200, body: { status: 'approved', sessionToken: 's1', installationId: 'install-1', os: 'windows' } }])
    const waiting: number[] = []
    const result = await requestPairApproval({ ...base, fetchImpl, onWaiting: ({ expiresAt }) => waiting.push(expiresAt) })
    if (result.status !== 'approved') throw new Error(`expected approved, got ${result.status}`)
    expect(paths).toEqual(['/pair/request', '/pair/request/wait', '/pair/request/wait'])
    expect(waiting).toEqual([5])
    expect(result.result).toMatchObject({ sessionToken: 's1', installationId: 'install-1', server: { id: 'install-1', label: '10.0.0.2:3000', sessionToken: 's1', os: 'windows' } })
  })

  test('denied and expired end the wait', async () => {
    for (const status of ['denied', 'expired'] as const) {
      const { fetchImpl } = scripted([started, { status: 200, body: { status } }])
      expect(await requestPairApproval({ ...base, fetchImpl })).toEqual({ status })
    }
  })

  test('a host without the route is unavailable', async () => {
    const { paths, fetchImpl } = scripted([{ status: 404, body: { error: 'not found' } }])
    expect(await requestPairApproval({ ...base, fetchImpl })).toEqual({ status: 'unavailable' })
    expect(paths).toEqual(['/pair/request'])
  })

  test('429 and a network failure throw a clear error', async () => {
    const limited = scripted([{ status: 429, body: { error: 'Too many pairing attempts' } }])
    await expect(requestPairApproval({ ...base, fetchImpl: limited.fetchImpl })).rejects.toThrow('too many requests')
    const offline = scripted([new TypeError('fetch failed')])
    await expect(requestPairApproval({ ...base, fetchImpl: offline.fetchImpl })).rejects.toThrow('Could not reach 10.0.0.2:3000')
  })

  test('works against the real routes', async () => {
    const approvals = new PairApprovals()
    approvals.subscribe((open) => { for (const request of open) approvals.decide(request.requestId, 'approve') })
    const { server, baseUrl } = await listen({ pairApprovals: approvals })
    try {
      const result = await requestPairApproval({ url: baseUrl, deviceLabel: 'Mac', checkCode: 'K7QX-M2PA' })
      if (result.status !== 'approved') throw new Error(`expected approved, got ${result.status}`)
      expect(auth.verifySessionToken(result.result.sessionToken)?.deviceLabel).toBe('Mac')
    } finally {
      await close(server)
    }
  })
})

describe('host.pairApprovalsChanged', () => {
  const event: HostEvent = { type: 'host.pairApprovalsChanged', payload: { approvals: [] }, occurredAt: 0 }
  // SAFETY: the audience decides this event before it reads any share.
  const shares = {} as Parameters<typeof eventVisibleTo>[2]

  test('reaches only connections that may approve', async () => {
    const owner: Principal = { kind: 'owner', via: 'local', deviceId: null, deviceLabel: 'Mac', expiresAt: null }
    const remoteOwner: Principal = { kind: 'owner', via: 'grant', userId: 'u1', deviceId: 'd1', deviceLabel: 'Phone', expiresAt: Date.now() + 60_000 }
    const admin: Principal = { kind: 'org-member', userId: 'u2', organizationId: 'o1', organizationRole: 'owner', teamIds: [], hostKind: 'personal', displayName: 'Admin', deviceId: 'd2', expiresAt: Date.now() + 60_000, deviceLabel: 'Laptop' }
    const guest: Principal = { kind: 'guest', guestId: 'g1', displayName: 'Guest', deviceId: 'g1', share: { resource: { kind: 'session', id: 's1' }, role: 'viewer', sharedByUserId: 'u1', linkSecretHash: 'h' }, expiresAt: Date.now() + 60_000, deviceLabel: 'Guest link' }
    expect(await eventVisibleTo(owner, event, shares)).toBe(true)
    expect(await eventVisibleTo({ kind: 'system' }, event, shares)).toBe(true)
    expect(await eventVisibleTo(remoteOwner, event, shares)).toBe(false)
    expect(await eventVisibleTo(admin, event, shares)).toBe(false)
    expect(await eventVisibleTo(guest, event, shares)).toBe(false)
  })
})

async function listen(opts: { pairApprovals: InstanceType<typeof PairApprovals>; pairingDisabled?: () => boolean; viaTunnel?: boolean }): Promise<{ server: Server; baseUrl: string }> {
  let port = 0
  const { server } = buildHttpServer({
    host: '127.0.0.1',
    port: 0,
    getPort: () => port,
    requireAuth: () => true,
    isTrustedRequester: async () => false,
    isTunnelRequest: () => opts.viaTunnel ?? false,
    pairingDisabled: opts.pairingDisabled,
    pairApprovals: opts.pairApprovals,
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = z.object({ port: z.number().int() }).safeParse(server.address())
      if (!address.success) reject(new Error('test server did not bind to a TCP port'))
      else {
        port = address.data.port
        resolve()
      }
    })
  })
  return { server, baseUrl: `http://127.0.0.1:${port}` }
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function post(baseUrl: string, path: string, body: object): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json() }
}
