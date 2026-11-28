import { afterEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
mock.module('node:sqlite', () => ({ DatabaseSync }))
const { HostPairings } = await import('@solus/server/host/host-pairings')
const { hostCredential, readHostRecords, readHostList, removeHostListing, putHostListing, saveHostConnection } = await import('@solus/server/host/host-list')
const { getDb } = await import('@solus/server/db')
import { loadHostIdentity } from '@solus/server/host/host-identity'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const folder = mkdtempSync(join(tmpdir(), 'solus-pairing-identity-'))
const identity = loadHostIdentity(folder)
const URL = 'http://10.0.0.2:3000'
const CODE = '482913'
const TOKEN = 'private-host-token'
const DAY = 24 * 60 * 60 * 1000

function harness(options: { self?: string; pairReply?: () => Response; key?: boolean; pairGate?: Promise<void>; refreshGate?: Promise<void>; refuseRefresh?: boolean; approve?: ApproveStub; isSilent?: () => boolean } = {}) {
  const sent: Array<{ url: string; authorization: string | null; redirect?: RequestRedirect }> = []
  const pairBodies: Array<{ replacesSessionToken?: string }> = []
  const pairTokens: string[] = []
  let time = 1
  const pairStarted = deferred()
  const refreshStarted = deferred()
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new globalThis.URL(String(input))
    sent.push({ url: url.href, authorization: new Headers(init?.headers).get('authorization'), redirect: init?.redirect })
    if (url.pathname === '/health') {
      if (options.isSilent?.()) throw new TypeError('fetch failed')
      const nonce = url.searchParams.get('nonce')
      return Response.json({ ok: true, installationId: 'remote', name: 'Windows', ...(nonce ? { proof: identity.proveTo(nonce, 'remote') } : {}) })
    }
    if (url.pathname === '/pair') {
      pairStarted.resolve()
      pairTokens.push(JSON.parse(String(init?.body)).pairToken)
      await options.pairGate
      if (options.pairReply) return options.pairReply()
      expect(JSON.parse(String(init?.body)).pairToken).toBe(CODE)
      pairBodies.push(JSON.parse(String(init?.body)))
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
  const service = new HostPairings(() => options.self ?? 'self', () => 'Mac', fetchImpl, () => time, options.approve)
  return { service, sent, pairBodies, pairTokens, pairStarted: pairStarted.promise, refreshStarted: refreshStarted.promise, advance: (days = 1) => { time += days * DAY + 1 } }
}
type ApproveStub = ConstructorParameters<typeof HostPairings>[4]
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
    expect(h.service.snapshot().hosts[0]?.listing.label).toBe('My Windows machine')
    expect(readHostRecords()).toHaveLength(1)
    expect(harness().service.snapshot().hosts).toHaveLength(1)
    expect(await h.service.credential('remote')).toBe(TOKEN)
    expect(h.sent.find((call) => call.url.endsWith('/pair'))?.redirect).toBe('error')
  })

  test('pairing a host again replaces this host token there and gives clients a newer pairing to follow', async () => {
    // WHY: a client whose own token the host refuses pairs again once for each newer `pairedAt`;
    // the remote host revokes the token this pairing replaces, so it keeps one device row.
    const h = harness()
    await h.service.pair({ url: URL, code: CODE })
    const first = h.service.snapshot().hosts[0]!.pairedAt
    h.advance()
    await h.service.pair({ url: URL, code: CODE })
    expect(h.pairBodies.map((body) => body.replacesSessionToken)).toEqual([undefined, TOKEN])
    expect(h.service.snapshot().hosts[0]!.pairedAt).toBeGreaterThan(first)
  })

  test('a rejected code is never reflected in an error or stored', async () => {
    const h = harness({ pairReply: () => Response.json({ error: `Rejected ${CODE}` }, { status: 401 }) })
    const error = await h.service.pair({ url: URL, code: CODE }).catch((error: Error) => error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain('HTTP 401')
    expect(String(error)).toContain('solus pair')
    expect(String(error)).not.toContain(CODE)
    expect(h.service.snapshot().hosts).toEqual([])
  })

  test.each([
    ['rate limit', () => new Response(null, { status: 429 }), 'Too many pairing attempts'],
    ['server error', () => new Response(null, { status: 503 }), 'HTTP 503'],
    ['unusable reply', () => new Response('<html>Proxy page</html>'), 'did not include a session token'],
    ['network failure', () => { throw new TypeError(`Connection failed for ${CODE}`) }, 'Could not send the pairing request'],
  ] as const)('reports a %s after a successful health check', async (_failure, pairReply, message) => {
    const h = harness({ pairReply })
    const error = await h.service.pair({ url: URL, code: CODE }).catch((error: Error) => error)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain(message)
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

  test('a value that is not a pairing code is refused before any request goes to the host', async () => {
    // WHY: docs/plans/add-machine-card.md rule 1. A person typed their Windows password where a code goes, and it was sent.
    for (const value of ['hunter2!Windows', '12345', 'private-pairing-code']) {
      const h = harness()
      await expect(h.service.pair({ url: URL, code: value })).rejects.toThrow('Nothing was sent')
      expect(h.sent).toEqual([])
    }
    const h = harness()
    await expect(h.service.pair({ url: URL, code: 'http://10.0.0.9:3000/pair#token=abc' })).rejects.toThrow('different server')
    expect(h.sent).toEqual([])
  })

  test('a pair link sends its token, and a typed code may have spaces', async () => {
    const h = harness({ pairReply: () => Response.json({ sessionToken: TOKEN, installationId: 'remote', identityKey: identity.publicKey() }) })
    await h.service.pair({ url: URL, code: `${URL}/pair#token=link-token` })
    await h.service.pair({ url: URL, code: '482 913' })
    expect(h.pairTokens).toEqual(['link-token', CODE])
  })

  // WHY: a found machine that trusts its local network must pair with nobody at
  // it, and one that does not must say a code is needed, not that a code was wrong.
  test('with no code, the host joins as a device the target network trusts, or is told a code is needed', async () => {
    const refused = harness({ pairReply: () => new Response(null, { status: 401 }) })
    await expect(refused.service.pair({ url: URL })).rejects.toThrow('Windows does not let this host join without a pairing code.')
    expect(refused.service.snapshot().hosts).toEqual([])
    const trusted = harness({ pairReply: () => Response.json({ sessionToken: TOKEN, installationId: 'remote', identityKey: identity.publicKey() }) })
    const host = await trusted.service.pair({ url: URL })
    expect([host.installationId, trusted.pairTokens]).toEqual(['remote', [undefined]])
  })

  test('with no label, the host is named by the name it reports', async () => {
    // WHY: docs/plans/add-machine-card.md rule 5. An agent's guess ("Windows machine") must not outrank the host's own name.
    const host = await harness().service.pair({ url: URL, code: CODE })
    expect(host.label).toBe('Windows')
    expect(host.hasUserLabel).toBeUndefined()
  })

  test('a check code pairs through an approval request and is saved like a code', async () => {
    const asked: Array<Parameters<NonNullable<ApproveStub>>[0]> = []
    const approve: ApproveStub = async (input) => {
      asked.push(input)
      return { status: 'approved', result: { sessionToken: TOKEN, installationId: 'remote', server: { id: 'remote', label: input.reportedName ?? 'x', routes: [{ kind: 'lan', url: URL }], sessionToken: TOKEN, installationId: 'remote', identityKey: identity.publicKey(), lastConnected: 1 } } }
    }
    const h = harness({ approve })
    const host = await h.service.pair({ url: URL, checkCode: 'k7qm-2xfd' })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ url: URL, checkCode: 'K7QM-2XFD', deviceLabel: 'Mac (Solus host)', reportedName: 'Windows' })
    expect(host.label).toBe('Windows')
    expect(hostCredential('remote', 'pairing')).toBe(TOKEN)
    expect(JSON.stringify(h.service.snapshot())).not.toContain(TOKEN)
    // No pairing code went anywhere.
    expect(h.sent.some((call) => call.url.endsWith('/pair'))).toBe(false)
  })

  test.each([
    ['denied', 'denied the request'],
    ['expired', 'before it expired'],
    ['unavailable', 'does not take approval requests'],
  ] as const)('an approval request that is %s saves nothing', async (status, message) => {
    const h = harness({ approve: async () => ({ status }) })
    await expect(h.service.pair({ url: URL, checkCode: 'K7QM-2XFD' })).rejects.toThrow(message)
    expect(h.service.snapshot().hosts).toEqual([])
  })

  test('a check code of the wrong shape is refused before any request', async () => {
    let asked = false
    const h = harness({ approve: async () => { asked = true; return { status: 'denied' } } })
    await expect(h.service.pair({ url: URL, checkCode: 'O0O0-I1I1' })).rejects.toThrow('not a check code')
    expect(asked).toBe(false)
    expect(h.sent).toEqual([])
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
const { setHostPairingTools, removeHostAgentTool } = await import('@solus/server/execution/agents/tools/host-pairing-tools')
import type { AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
const context: AgentToolContext = {
  provider: 'codex', cwd: '/tmp', sessionId: () => 'pairing-session', abortSignal: new AbortController().signal,
  parentToolUseId: () => undefined,
  emit: () => {},
}

test('remove_host forgets a paired host for the local owner', async () => {
  const h = harness()
  setHostPairingTools(h.service)
  try {
    await h.service.pair({ url: URL, code: CODE })
    const result = await withWorkspaceToolAuthority(OWNER, () => removeHostAgentTool.execute({ installationId: 'remote' }, context))
    expect(result.ok).toBe(true)
    expect(result.text).not.toContain(TOKEN)
    expect(hostCredential('remote', 'pairing')).toBeNull()
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
  const { registerHostListHandlers } = await import('@solus/server/transport/handlers/host-list-handlers')
  const server = new SolusServer()
  const h = harness()
  registerHostPairingHandlers(server, h.service)
  const announced: string[][] = []
  const stop = registerHostListHandlers(server, {
    // A client that reacts immediately must read the committed host record.
    broadcast: () => announced.push(h.service.snapshot().hosts.map((host) => host.listing.installationId)),
  })
  const caller = { clientId: 'test-client', principal: OWNER }
  try {
    await server.handle('hostsPair', [{ url: URL, code: CODE }], caller)
    expect(announced).toEqual([['remote']])
    expect((await server.handle('hostListRead', [], caller)).map((host) => host.installationId)).toEqual(['remote'])
    expect((await server.handle('hostsListPaired', [], caller)).hosts).toHaveLength(1)
    await expect(server.handle('hostsListPaired', [], { ...caller, principal: { kind: 'owner', via: 'grant', userId: 'alice', deviceId: 'a', deviceLabel: 'Remote', expiresAt: 1 } })).rejects.toThrow()
    expect(await server.handle('hostsForget', ['remote'], caller)).toEqual({ removed: true })
    expect(announced).toEqual([['remote'], []])
  } finally { stop() }
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
  expect(h.service.snapshot().hosts.map((host) => host.listing.installationId)).toEqual(['remote'])
})

// One model (docs/plans/host-reach.md): a machine a host pairs is the person's machine
// on every device. No pairing is kept from the device list until a second step.
test('a pairing joins the host list that owner devices read, and forget removes it', async () => {
  const h = harness()
  const listing = await h.service.pair({ url: URL, code: CODE })
  expect(h.service.snapshot().hosts[0]).toMatchObject({ url: URL })
  expect(readHostList()).toEqual([listing])
  expect(h.service.forget('remote')).toBe(true)
  expect(readHostList()).toEqual([])
})

test('an open pairing renews on use once it is due, coalesces requests and refuses revoked credentials', async () => {
  const h = harness()
  await h.service.pair({ url: URL, code: CODE })
  expect(await h.service.renewOnUse('remote')).toBe(true)
  expect(h.sent.filter(({ url }) => url.endsWith('/auth/refresh'))).toHaveLength(0)
  h.advance()
  expect(await Promise.all([h.service.renewOnUse('remote'), h.service.renewOnUse('remote')])).toEqual([true, true])
  expect(h.sent.filter(({ url }) => url.endsWith('/auth/refresh'))).toHaveLength(1)
  expect(hostCredential('remote', 'pairing')).toBe('refreshed-token')

  const revoked = harness({ refuseRefresh: true })
  await revoked.service.pair({ url: URL, code: CODE })
  revoked.advance()
  expect(await revoked.service.renewOnUse('remote')).toBe(false)
  expect(hostCredential('remote', 'pairing')).toBeNull()
})

test('only a local owner can relay paged session text through an explicit link', async () => {
  const { SolusServer } = await import('@solus/server/transport/server')
  const { registerHostPairingHandlers } = await import('@solus/server/transport/handlers/host-pairing-handlers')
  const { asHostApi } = await import('@solus/client-core/host-api')
  const { HostEventSubscriber } = await import('@solus/client-core/host-event-subscriber')
  const h = harness()
  await h.service.pair({ url: URL, code: CODE })
  const server = new SolusServer()
  let calls = 0
  registerHostPairingHandlers(server, h.service, {
    connectPaired: (installationId) => {
      calls++
      if (installationId !== 'remote') return { error: 'This host is no longer linked to that machine.' }
      return {
        hostId: installationId, installationId, label: 'Remote',
        events: new HostEventSubscriber(), onReconnected: () => () => {},
        call: (_what, request) => request(),
        api: asHostApi({
          getSessionInfo: async (sessionId: string) => ({
            sessionId, provider: 'codex', firstMessage: null, slug: null, lastTimestamp: '', size: 1, cwd: '/secret', projectPath: '/secret',
          }),
          loadSessionPage: async (request: { before?: string; turnLimit: number }) => {
            expect(request).toMatchObject({ before: 'older', turnLimit: 12 })
            return { messages: [
              { role: 'assistant', content: 'A reply', timestamp: 1, forkPointId: 'private' },
              { role: 'tool_use', content: 'private', timestamp: 2 },
            ], before: 'next', turnDiffs: [{ turnIndex: 1, endedAt: 1 }] }
          },
        }),
      }
    },
    disconnectPairing: () => {},
  })
  const owner = { clientId: 'local', principal: OWNER }
  const grant = { kind: 'owner', via: 'grant', userId: 'alice', deviceId: 'a', deviceLabel: 'Remote', expiresAt: 1 } as const
  await expect(server.handle('hostsLinkedSessionPage', ['remote', 'session', 'older', 12], { ...owner, principal: grant })).rejects.toThrow()
  expect(calls).toBe(0)
  await expect(server.handle('hostsLinkedSessionPage', ['unlinked', 'session', 'older', 12], owner)).rejects.toThrow('no longer linked')
  const read = await server.handle('hostsLinkedSessionPage', ['remote', 'session', 'older', 12], owner)
  expect(read.page).toEqual({ before: 'next', messages: [{ role: 'assistant', content: 'A reply', timestamp: 1, messageId: undefined }] })
  expect(read.meta).toMatchObject({ sessionId: 'session', provider: 'codex', cwd: '', projectPath: '' })
})

describe('link health', () => {
  // A link that breaks shows how, in the list every owner client already follows, before an agent tries to use it.
  const healthOf = (h: ReturnType<typeof harness>) => h.service.listed().hosts[0]?.health

  test('a new link was reached when it was made and ends 30 days later, and nothing is dialed to say so', async () => {
    const h = harness()
    await h.service.pair({ url: URL, code: CODE })
    const before = h.sent.length
    expect(healthOf(h)).toEqual({ lastReachedAt: 1, lastError: null, expiresAt: 1 + 30 * DAY })
    expect(h.sent.length).toBe(before)
    // The list that agents and clients read inside the host carries no health.
    expect(h.service.snapshot().hosts[0]?.health).toBeUndefined()
  })

  test('a failed use says why, a use that works clears it, and each change is announced to clients', async () => {
    const { onHostRecordsChanged } = await import('@solus/server/host/host-list')
    let isSilent = false
    const h = harness({ isSilent: () => isSilent })
    await h.service.pair({ url: URL, code: CODE })
    let announced = 0
    const stop = onHostRecordsChanged(() => announced++)
    try {
      isSilent = true
      expect(await h.service.credential('remote')).toBeNull()
      expect(healthOf(h)?.lastError).toContain(URL)
      expect(announced).toBe(1)
      // The same failure again is not news.
      expect(await h.service.credential('remote')).toBeNull()
      expect(announced).toBe(1)
      h.service.noteUse('remote', null)
      expect(healthOf(h)?.lastError).toBeNull()
      expect(announced).toBe(2)
      // Another good use is not news either.
      h.service.noteUse('remote', null)
      expect(announced).toBe(2)
    } finally { stop() }
  })

  test('a refused credential ends the link, with the refusal as its last error', async () => {
    const h = harness({ refuseRefresh: true })
    await h.service.pair({ url: URL, code: CODE })
    h.advance()
    expect(await h.service.credential('remote')).toBeNull()
    expect(healthOf(h)).toMatchObject({ expiresAt: null, lastError: expect.stringContaining('refused') })
  })

  test('a credential nobody used for 30 days has ended', async () => {
    const h = harness()
    await h.service.pair({ url: URL, code: CODE })
    h.advance(30)
    expect(healthOf(h)?.expiresAt).toBeNull()
  })

  test('a renewal moves the last reach and the end forward, and pairing again clears an old error', async () => {
    const h = harness()
    await h.service.pair({ url: URL, code: CODE })
    h.service.noteUse('remote', 'It did not accept a connection.')
    h.advance()
    expect(await h.service.credential('remote')).toBe('refreshed-token')
    expect(healthOf(h)).toEqual({ lastReachedAt: 2 + DAY, lastError: null, expiresAt: 2 + DAY + 30 * DAY })
    h.service.noteUse('remote', 'It did not accept a connection.')
    await h.service.pair({ url: URL, code: CODE })
    expect(healthOf(h)?.lastError).toBeNull()
  })

  test('the owner list over RPC carries each link with its health', async () => {
    const { SolusServer } = await import('@solus/server/transport/server')
    const { registerHostPairingHandlers } = await import('@solus/server/transport/handlers/host-pairing-handlers')
    const server = new SolusServer()
    const h = harness()
    registerHostPairingHandlers(server, h.service)
    await h.service.pair({ url: URL, code: CODE })
    const listed = await server.handle('hostsListPaired', [], { clientId: 'test-client', principal: OWNER })
    expect(listed.hosts[0]?.health?.expiresAt).toBe(1 + 30 * DAY)
  })
})
