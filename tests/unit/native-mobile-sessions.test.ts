import { describe, expect, test } from 'bun:test'
import type { SessionRecord, SessionRecordList } from '@solus/contracts/types'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import { SessionDirectory } from '../../apps/mobile/src/features/sessions/session-directory'
import { deriveLayout } from '../../apps/mobile/src/features/layout/lib/layout'
import { createHostWorld, FakeApi, flushPromises, healthFetch } from './helpers/native-mobile-fakes'

const sessionRecord = (sessionId: string, lastActivityAt: number, parentSessionId: string | null = null): SessionRecord => ({
  sessionId, organizationId: 'local', publication: 'private' as SessionRecord['publication'], ownerUserId: null, provider: 'claude-code',
  projectPath: '/work/app', projectRemote: null, runnerHostId: null, title: sessionId, customTitle: null, status: 'idle',
  model: null, reasoningEffort: null, parentSessionId, rootSessionId: parentSessionId, createdAt: 0, lastActivityAt,
  size: 0, cwd: '/work/app', slug: null, isWorktree: false, branch: null, projectRoot: null, delegation: null,
})

async function setup(api: FakeApi) {
  const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a', 'http://b:1': 'inst-b' }), api: () => api })
  await world.registry.load()
  await world.registry.savePaired({ id: 'inst-a', label: 'A', url: 'http://a:1' }, 'ta')
  await world.registry.savePaired({ id: 'inst-b', label: 'B', url: 'http://b:1' }, 'tb')
  const directory = new SessionDirectory((hostId) => world.connections.connection(hostId))
  return { world, directory }
}

describe('native session directory', () => {
  test('lists a project\'s sessions newest first, without delegated children', async () => {
    const list: SessionRecordList = { records: [sessionRecord('old', 1), sessionRecord('new', 5), sessionRecord('child', 9, 'new')], indexing: false }
    const api = new FakeApi().on('sessionRecordList', () => list)
    const { directory } = await setup(api)
    await directory.loadSessions('inst-a', '/work/app')
    const state = directory.sessionsOf('inst-a', '/work/app')
    expect(state.kind === 'loaded' && state.items.map((item) => item.sessionId)).toEqual(['new', 'old'])
    expect(api.callsOf('sessionRecordList')[0]).toEqual([{ projectPath: '/work/app', includeWorktrees: true }])
  })

  test('the chats of a host are one list, read from the host by the chats filter', async () => {
    // WHY: each chat has its own folder, so no project path names them all. The
    // phone asks the host for its chats, and the list is apart from every project.
    const api = new FakeApi().on('sessionRecordList', () => ({ records: [sessionRecord('chat', 1)], indexing: false }))
    const { directory } = await setup(api)
    await directory.loadSessions('inst-a', NEW_CHAT_DIRECTORY)
    expect(api.callsOf('sessionRecordList')[0]).toEqual([{ chats: true }])
    expect(directory.sessionsOf('inst-a', NEW_CHAT_DIRECTORY).kind).toBe('loaded')
    expect(directory.sessionsOf('inst-a', '/work/app').kind).toBe('idle')
  })

  test('one session id on two hosts is two entries', async () => {
    const api = new FakeApi().on('sessionRecordList', () => ({ records: [sessionRecord('same', 1)], indexing: false }))
    const { directory } = await setup(api)
    await directory.loadSessions('inst-a', '/work/app')
    expect(directory.sessionsOf('inst-a', '/work/app').kind).toBe('loaded')
    expect(directory.sessionsOf('inst-b', '/work/app').kind).toBe('idle')
  })

  test('a read that started before the host\'s server session changed is dropped', async () => {
    let answer!: (list: SessionRecordList) => void
    const api = new FakeApi().on('sessionRecordList', () => new Promise<SessionRecordList>((resolve) => { answer = resolve }))
    const { directory, world } = await setup(api)
    const pending = directory.loadSessions('inst-a', '/work/app')
    await flushPromises()
    const transport = world.transports[0]!
    await transport.accept()
    transport.fail('dropped')
    await transport.accept(false)
    answer({ records: [sessionRecord('stale', 1)], indexing: false })
    await pending
    expect(directory.sessionsOf('inst-a', '/work/app').kind).toBe('loading')
  })

  test('forgetting a host drops its lists', async () => {
    const api = new FakeApi().on('listProjects', () => [{ key: 'k', path: '/work/app', folderName: 'app', addedAt: '', repositoryKey: null }])
    const { directory } = await setup(api)
    await directory.loadProjects('inst-a')
    directory.forgetHost('inst-a')
    expect(directory.projectsOf('inst-a').kind).toBe('idle')
  })
})

describe('native adaptive layout', () => {
  test('a full or wide iPad window keeps a sidebar; a narrow window or landscape phone stacks', () => {
    expect(deriveLayout({ width: 1024, height: 1366 })).toEqual({ variant: 'split', sidebarWidth: 328 })
    expect(deriveLayout({ width: 1366, height: 1024 })).toEqual({ variant: 'split', sidebarWidth: 380 })
    // iPad Split View at a third of the screen, and an iPhone in landscape.
    expect(deriveLayout({ width: 375, height: 1024 })).toEqual({ variant: 'compact' })
    expect(deriveLayout({ width: 932, height: 430 })).toEqual({ variant: 'compact' })
  })
})
