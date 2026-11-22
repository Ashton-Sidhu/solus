import { afterEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { HostPairings } = await import('@solus/server/host/host-pairings')
const { hostCredential, readHostRecords, removeHostListing, putHostListing, saveHostConnection } = await import('@solus/server/host/host-list')
const { getDb } = await import('@solus/server/db')
import { loadHostIdentity } from '@solus/server/host/host-identity'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const folder = mkdtempSync(join(tmpdir(), 'solus-pairing-identity-'))
const identity = loadHostIdentity(folder)
const URL = 'http://10.0.0.2:3000'
const CODE = 'private-pairing-code'
const TOKEN = 'private-host-token'
const DAY = 24 * 60 * 60 * 1000

function harness(options: { self?: string; refuse?: boolean; key?: boolean; pairGate?: Promise<void>; refreshGate?: Promise<void>; refuseRefresh?: boolean } = {}) {
  const sent: Array<{ url: string; authorization: string | null; redirect?: RequestRedirect }> = []
  let time = 1
  const pairStarted = deferred()
  const refreshStarted = deferred()
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new globalThis.URL(String(input))
    sent.push({ url: url.href, authorization: new Headers(init?.headers).get('authorization'), redirect: init?.redirect })
    if (url.pathname === '/health') {
      const nonce = url.searchParams.get('nonce')
      return Response.json({ ok: true, installationId: 'remote', name: 'Windows', ...(nonce ? { proof: identity.proveTo(nonce, 'remote') } : {}) })
    }
    if (url.pathname === '/pair') {
      pairStarted.resolve()
      await options.pairGate
      if (options.refuse) return Response.json({ error: `Rejected ${CODE}` }, { status: 401 })
      expect(JSON.parse(String(init?.body)).pairToken).toBe(CODE)
      return Response.json({ sessionToken: TOKEN, installationId: 'remote', os: 'windows', ...(options.key === false ? {} : { identityKey: identity.publicKey() }) })
    }
    if (url.pathname === '/auth/refresh') {
      refreshStarted.resolve()
      await options.refreshGate
      if (options.refuseRefresh) return Response.json({ error: 'Unauthorized' }, { status: 401 })
      return Response.json({ sessionToken: 'refreshed-token' })
    }
    return new Response(null, { status: 404 })
  }
  const service = new HostPairings(() => options.self ?? 'self', () => 'Mac', fetchImpl, () => time)
  return { service, sent, pairStarted: pairStarted.promise, refreshStarted: refreshStarted.promise, advance: () => { time += DAY + 1 } }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
afterEach(() => { getDb().exec('DELETE FROM host_list') })
import { afterAll } from 'bun:test'
afterAll(() => rmSync(folder, { recursive: true, force: true }))

describe('explicit owner host pairing', () => {
  test('persists one credential outside listings, survives restart, and keeps client labels', async () => {
    const h = harness()
    const host = await h.service.pair({ url: URL, code: CODE, label: 'Build machine' })
    expect(host.label).toBe('Build machine')
    expect(JSON.stringify(h.service.snapshot())).not.toContain(TOKEN)
    expect(JSON.stringify(readHostRecords())).not.toContain(TOKEN)
    expect(hostCredential('remote', 'pairing')).toBe(TOKEN)
    putHostListing({ ...host, label: 'My Windows machine', hasUserLabel: true })
    await h.service.pair({ url: URL, code: CODE })
    expect(h.service.snapshot().hosts[0]?.label).toBe('My Windows machine')
    expect(readHostRecords()).toHaveLength(1)
    expect(harness().service.snapshot().hosts).toHaveLength(1)
    expect(await h.service.credential('remote')).toBe(TOKEN)
    expect(h.sent.find((call) => call.url.endsWith('/pair'))?.redirect).toBe('error')
  })

  test('a rejected code is never reflected in an error or stored', async () => {
    const h = harness({ refuse: true })
    const error = await h.service.pair({ url: URL, code: CODE }).catch((error: Error) => error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain(CODE)
    expect(h.service.snapshot().hosts).toEqual([])
  })

  test('refuses self, URL credentials, public HTTP, and old HTTP hosts', async () => {
    await expect(harness({ self: 'remote' }).service.pair({ url: URL, code: CODE })).rejects.toThrow('current host')
    await expect(harness().service.pair({ url: 'https://user:password@example.com', code: CODE })).rejects.toThrow('no credentials')
    await expect(harness().service.pair({ url: 'http://example.com', code: CODE })).rejects.toThrow('HTTPS')
    await expect(harness({ key: false }).service.pair({ url: URL, code: CODE })).rejects.toThrow('too old')
    expect(harness().service.snapshot().hosts).toEqual([])
  })

  test('forget clears every connection channel, then explicit pairing can restore it', async () => {
    const h = harness()
    const host = await h.service.pair({ url: URL, code: CODE })
    saveHostConnection(host, { kind: 'introduction', token: 'other-token', settings: { url: URL, introducedAt: 1, refreshedAt: 1, grantedDeviceId: 'other' } })
    expect(h.service.forget('remote')).toBe(true)
    expect(hostCredential('remote', 'pairing')).toBeNull()
    expect(hostCredential('remote', 'introduction')).toBeNull()
    expect(h.service.snapshot()).toEqual({ hosts: [], forgotten: ['remote'] })
    await h.service.pair({ url: URL, code: CODE })
    expect(h.service.snapshot().hosts).toHaveLength(1)
  })

  test('forget during pairing cannot be undone by the late reply', async () => {
    const gate = deferred()
    const h = harness({ pairGate: gate.promise })
    const pair = h.service.pair({ url: URL, code: CODE })
    await h.pairStarted
    h.service.forget('remote')
    gate.resolve()
    await expect(pair).rejects.toThrow('ended')
    expect(hostCredential('remote', 'pairing')).toBeNull()
  })

  test('forget during refresh cannot restore access', async () => {
    const gate = deferred()
    const h = harness({ refreshGate: gate.promise })
    await h.service.pair({ url: URL, code: CODE })
    h.advance()
    const refresh = h.service.credential('remote')
    await h.refreshStarted
    removeHostListing('remote')
    gate.resolve()
    expect(await refresh).toBeNull()
    expect(hostCredential('remote', 'pairing')).toBeNull()
  })
})

const OWNER = { kind: 'owner', via: 'local', expiresAt: null, deviceId: null, deviceLabel: 'Mac' } as const
const { withWorkspaceToolAuthority } = await import('@solus/server/admission/workspace-tool-authority')
const { setHostPairingTools, pairHostAgentTool, removeHostAgentTool } = await import('@solus/server/execution/agents/tools/host-pairing-tools')
const { requestSecrets, answerSecretRequest } = await import('@solus/server/execution/sessions/secret-requests')
import type { AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
const context: AgentToolContext = {
  provider: 'codex', cwd: '/tmp', sessionId: () => 'pairing-session', abortSignal: new AbortController().signal,
  parentToolUseId: () => undefined,
  emit: (event) => {
    if (event.type === 'question_request') answerSecretRequest('pairing-session', event.questionId, [CODE])
  },
}

test('chat tools consume a session-bound secret once and return no credentials', async () => {
  const h = harness()
  setHostPairingTools(h.service)
  try {
    const answer = await requestSecrets(context, [{ name: 'Code', reason: 'Pair Windows' }])
    if (!('secrets' in answer)) throw new Error('No answer')
    const outcome = answer.secrets[0]!
    if (outcome.status !== 'saved' || !('secretRef' in outcome)) throw new Error('No secret ref')
    await withWorkspaceToolAuthority(OWNER, async () => {
      const result = await pairHostAgentTool.execute({ url: URL, secretRef: outcome.secretRef }, context)
      expect(result.ok).toBe(true)
      expect(result.text).not.toContain(CODE)
      expect(result.text).not.toContain(TOKEN)
      const again = await pairHostAgentTool.execute({ url: URL, secretRef: outcome.secretRef }, context)
      expect(again.ok).toBe(false)
      expect((await removeHostAgentTool.execute({ installationId: 'remote' }, context)).ok).toBe(true)
      expect(hostCredential('remote', 'pairing')).toBeNull()
    })
  } finally { setHostPairingTools(null) }
})

test('a system turn or an account owner grant cannot grant local host access', async () => {
  setHostPairingTools(harness().service)
  try {
    expect((await removeHostAgentTool.execute({ installationId: 'remote' }, context)).ok).toBe(false)
    expect((await withWorkspaceToolAuthority({ kind: 'system' }, () => removeHostAgentTool.execute({ installationId: 'remote' }, context))).ok).toBe(false)
    const remoteOwner = { kind: 'owner', via: 'grant', userId: 'alice', deviceId: 'a', deviceLabel: 'Remote', expiresAt: 1 } as const
    expect((await withWorkspaceToolAuthority(remoteOwner, () => removeHostAgentTool.execute({ installationId: 'remote' }, context))).ok).toBe(false)
  } finally { setHostPairingTools(null) }
})

test('RPC uses the same pairing record and refuses an account grant', async () => {
  const { SolusServer } = await import('@solus/server/transport/server')
  const { registerHostPairingHandlers } = await import('@solus/server/transport/handlers/host-pairing-handlers')
  const server = new SolusServer()
  const h = harness()
  registerHostPairingHandlers(server, h.service)
  const caller = { clientId: 'test-client', principal: OWNER }
  await server.handle('hostsPair', [{ url: URL, code: CODE }], caller)
  expect((await server.handle('hostsListPaired', [], caller)).hosts).toHaveLength(1)
  await expect(server.handle('hostsListPaired', [], { ...caller, principal: { kind: 'owner', via: 'grant', userId: 'alice', deviceId: 'a', deviceLabel: 'Remote', expiresAt: 1 } })).rejects.toThrow()
  expect(await server.handle('hostsForget', ['remote'], caller)).toEqual({ removed: true })
})

test('client pairing uses the host token only on the remote socket and returns a new one-use code', async () => {
  const { clientFrameSchema } = await import('@solus/contracts/host-socket')
  let presented = ''
  let called = ''
  const remote = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response('Not found', { status: 404 }) },
    websocket: {
      message(socket, text) {
        const frame = clientFrameSchema.parse(JSON.parse(String(text)))
        if (frame.t === 'hello') {
          if (frame.credential?.kind === 'session-token') presented = frame.credential.token
          socket.send(JSON.stringify({ t: 'welcome', epoch: 'test', seq: 0, recovered: false }))
        } else if (frame.t === 'rpc') {
          called = frame.method
          socket.send(JSON.stringify({ t: 'result', id: frame.id, result: { token: 'fresh-client-code', code: '123456', expiresAt: Date.now() + 1000 } }))
        }
      },
    },
  })
  try {
    const h = harness()
    await h.service.pair({ url: `http://127.0.0.1:${remote.port}`, code: CODE })
    const result = await h.service.forClient('remote')
    expect(presented).toBe(TOKEN)
    expect(called).toBe('connectionsGeneratePairToken')
    expect(result.code).toBe('fresh-client-code')
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  } finally { await remote.stop(true) }
})

test('an explicit pairing is available to owner agents, ahead of an old introduction, and never to members', async () => {
  const { RemoteHosts } = await import('@solus/server/execution/orchestration/remote-hosts')
  const h = harness()
  await h.service.pair({ url: URL, code: CODE })
  const hosts = new RemoteHosts(() => null,
    { list: () => ({ hosts: [{ installationId: 'remote', label: 'Old introduction', url: URL, introducedAt: 1 }], refused: [] }), credential: async () => 'old-token' },
    () => 'self', async () => [], () => 'self', { list: () => [], credential: () => null }, fetch, h.service)
  try {
    const owner = await hosts.list({ account: null, isOwner: true })
    if ('error' in owner) throw new Error(owner.error)
    expect(owner).toHaveLength(1)
    expect(owner[0]?.source).toBe('paired')
    expect(await owner[0]?.credential()).toBe(TOKEN)
    expect(await hosts.list({ account: null, isOwner: false })).toHaveProperty('error')
    h.service.forget('remote')
    expect(await h.service.credential('remote')).toBeNull()
  } finally { hosts.close() }
})

 test('an expired pairing stays listed for repair, without keeping its refused credential', async () => {
  const h = harness({ refuseRefresh: true })
  await h.service.pair({ url: URL, code: CODE })
  h.advance()
  expect(await h.service.credential('remote')).toBeNull()
  expect(hostCredential('remote', 'pairing')).toBeNull()
  expect(h.service.snapshot().hosts.map((host) => host.installationId)).toEqual(['remote'])
})
