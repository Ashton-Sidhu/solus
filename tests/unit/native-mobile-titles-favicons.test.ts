import { describe, expect, test } from 'bun:test'
import { SendOutbox } from '@solus/client-core/send-outbox'
import type { SessionRecord } from '@solus/contracts/types'
import { ConversationController, type ConversationTarget } from '../../apps/mobile/src/features/conversation/conversation-controller'
import { threadFaviconRoot } from '../../apps/mobile/src/features/threads/threadListV2'
import { resolveProjectFaviconUrl } from '../../apps/mobile/src/lib/project-favicon-url'
import { memoryKeyValueStore } from '../../apps/mobile/src/platform/ports'
import { createHostWorld, FakeApi, flushPromises, healthFetch, type FakeTransport } from './helpers/native-mobile-fakes'

async function connect(api: FakeApi, hostId = 'inst-a') {
  const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': hostId }), api: () => api })
  await world.registry.load()
  await world.registry.savePaired({ id: hostId, label: 'A', url: 'http://a:1' }, 'ta')
  const connection = world.connections.connection(hostId)!
  const transport = world.transports[0] as FakeTransport
  return { connection, transport }
}

const NEW_SESSION: ConversationTarget = { hostId: 'inst-a', newSession: { sessionId: 'new-1', provider: 'claude-code', workingDirectory: '/work/app' } }

async function openNew(api: FakeApi, options: { autoRename?: boolean; target?: ConversationTarget } = {}) {
  const { connection, transport } = await connect(api)
  await transport.accept()
  const storage = memoryKeyValueStore()
  let nextId = 0
  const controller = new ConversationController(options.target ?? NEW_SESSION, {
    connection,
    outbox: new SendOutbox(() => storage),
    runSettings: async () => ({ defaultPermissionMode: 'auto' }),
    executionPreferences: () => ({}),
    autoRenameSessions: () => options.autoRename ?? true,
    organizationId: () => null,
    uuid: () => `client-${++nextId}`,
    onChange: () => undefined,
  })
  await controller.load()
  return { controller, transport }
}

function namingApi(): FakeApi {
  return new FakeApi()
    .on('serverGetCapabilities', () => ({}))
    .on('start', () => ({ agents: [] }))
    .on('configGet', () => ({}))
    .on('describeSession', () => ({ lineage: null, meta: null }))
    .on('loadSessionPage', () => ({ messages: [], before: null }))
    .on('watchSession', () => ({ runtime: null }))
    .on('unwatchSession', () => undefined)
    .on('prompt', () => ({ disposition: 'started' }))
    .on('generateSessionMetadata', () => ({ title: 'Mobile session titles', description: 'Names sessions started on the phone.' }))
    .on('setSessionTitle', () => undefined)
}

describe('native session titles', () => {
  test('a session started on the phone is named from its opening prompt, as desktop names its own', async () => {
    const api = namingApi()
    const { controller, transport } = await openNew(api)
    await controller.send('mobile does not read our generated titles')
    transport.emitSession('new-1', { type: 'session_init', sessionId: 'provider-1', model: 'm', skills: [] })
    await flushPromises()
    expect(api.callsOf('generateSessionMetadata')[0]?.slice(0, 2)).toEqual(['mobile does not read our generated titles', '/work/app'])
    expect(api.callsOf('setSessionTitle')).toEqual([['new-1', 'Mobile session titles', 'generated', 'Names sessions started on the phone.']])
    expect(controller.run.title).toBe('Mobile session titles')

    // A later init (a resume) does not name it again.
    transport.emitSession('new-1', { type: 'session_init', sessionId: 'provider-1', model: 'm', skills: [] })
    await flushPromises()
    expect(api.callsOf('generateSessionMetadata')).toHaveLength(1)
  })

  test('a hand rename while the name is generated wins', async () => {
    let answer!: (value: { title: string; description: string }) => void
    const api = namingApi().on('generateSessionMetadata', () => new Promise((resolve) => { answer = resolve }))
    const { controller, transport } = await openNew(api)
    await controller.send('fix the header')
    transport.emitSession('new-1', { type: 'session_init', sessionId: 'provider-1', model: 'm', skills: [] })
    await flushPromises()
    transport.emit('session.titleChanged', { sessionId: 'new-1', title: 'My name', source: 'manual' })
    answer({ title: 'Generated', description: '' })
    await flushPromises()
    expect(controller.run.title).toBe('My name')
    expect(api.callsOf('setSessionTitle')).toEqual([])
  })

  test('with "name new sessions" off, the phone does not name it', async () => {
    const api = namingApi()
    const { controller, transport } = await openNew(api, { autoRename: false })
    await controller.send('fix it')
    transport.emitSession('new-1', { type: 'session_init', sessionId: 'provider-1', model: 'm', skills: [] })
    await flushPromises()
    expect(api.callsOf('generateSessionMetadata')).toEqual([])
  })

  test('an open saved session shows a name generated or typed on another client', async () => {
    const record = { sessionId: 'thread-1', provider: 'claude-code' as const, projectPath: '/work/app', cwd: '/work/app', model: null, reasoningEffort: null, title: 'fix the header please', customTitle: null }
    const api = namingApi()
    const { controller, transport } = await openNew(api, { target: { hostId: 'inst-a', record } })
    expect(controller.run.title).toBe('fix the header please')
    transport.emit('session.titleChanged', { sessionId: 'thread-1', title: 'Header fix', source: 'generated' })
    expect(controller.run.title).toBe('Header fix')
    // Opening a saved session never generates a name for it.
    expect(api.callsOf('generateSessionMetadata')).toEqual([])
  })
})

describe('native project favicons', () => {
  const faviconApi = (capabilities: () => object) => new FakeApi()
    .on('serverGetCapabilities', capabilities)
    .on('start', () => undefined)
    .on('assetFindUrl', (_ctx: unknown, request: { paths: string[] }) => ({ relativeUrl: '/api/assets/token', expiresAt: Date.now() + 3_600_000, path: request.paths[1] }))

  test('asks the project host for its own candidates and builds the URL on that host', async () => {
    const api = faviconApi(() => ({ assetUrls: true }))
    const { connection, transport } = await connect(api, 'host-fav-1')
    await transport.accept()
    expect(await resolveProjectFaviconUrl(connection, '/Users/me/solus/')).toBe('http://a:1/api/assets/token')
    const [, request] = api.callsOf('assetFindUrl')[0] as [unknown, { paths: string[] }]
    expect(request.paths).toContain('/Users/me/solus/favicon.svg')
  })

  test('a capability read that failed before the host connected is not remembered as "no favicon"', async () => {
    let capabilities: object = {}
    const api = faviconApi(() => capabilities)
    const { connection, transport } = await connect(api, 'host-fav-2')
    await transport.accept()
    // The first read answered empty, as a failed load does.
    expect(await resolveProjectFaviconUrl(connection, '/Users/me/solus')).toBeNull()
    capabilities = { assetUrls: true }
    await transport.accept(false)
    await flushPromises()
    expect(await resolveProjectFaviconUrl(connection, '/Users/me/solus')).toBe('http://a:1/api/assets/token')
  })

  test('a host that says it cannot serve assets is remembered', async () => {
    const api = faviconApi(() => ({ assetUrls: false }))
    const { connection, transport } = await connect(api, 'host-fav-3')
    await transport.accept()
    expect(await resolveProjectFaviconUrl(connection, '/p')).toBeNull()
    expect(await resolveProjectFaviconUrl(connection, '/p')).toBeNull()
    expect(api.callsOf('assetFindUrl')).toEqual([])
  })
})

describe('native thread row favicon root', () => {
  const record = (fields: Partial<SessionRecord>) => ({ projectPath: '-Users-me-solus', cwd: '/Users/me/solus', projectRoot: null, ...fields }) as SessionRecord

  test('the listed project wins', () => {
    expect(threadFaviconRoot(record({}), '/Users/me/solus')).toBe('/Users/me/solus')
  })

  test('a project the host does not list still shows its own mark, read from the session root', () => {
    expect(threadFaviconRoot(record({ cwd: '/Users/me/solus/.git/solus/worktrees/solus-1' }), null)).toBe('/Users/me/solus')
  })

  test('a new thread in a worktree shows its project\'s mark in the header', () => {
    const worktree = '/Users/me/solus/.git/solus/worktrees/solus-2'
    expect(threadFaviconRoot({ projectPath: worktree, cwd: worktree }, null)).toBe('/Users/me/solus')
  })

  test('the encoded storage name is not a folder to look in', () => {
    expect(threadFaviconRoot(record({ cwd: null }), null)).toBeNull()
  })
})
