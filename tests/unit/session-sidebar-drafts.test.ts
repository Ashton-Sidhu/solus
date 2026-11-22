import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { PinnedSession, Session } from '@solus/contracts/types'
import type { SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'
import { makePrompt } from '@solus/workspace-ui/contexts/workspace/session.factories'
import type { SessionSidebarStore as SidebarStore } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'

import { singleHostServerConnections } from './helpers/server-connections-mock'

const connections = singleHostServerConnections()
afterEach(() => connections.reset())
mock.module('@solus/client-core/server-connections', () => ({ serverConnections: connections }))
mock.module('@lucide/svelte', () => ({
  MessageSquare: () => {}, FileText: () => {}, LoaderCircle: () => {},
  CircleCheck: () => {}, CircleX: () => {}, Clock: () => {}, Activity: () => {},
  CircleDashed: () => {}, GitBranch: () => {}, GitMerge: () => {}, GitPullRequest: () => {}, CircleAlert: () => {},
}))

mock.module('@solus/workspace-ui/contexts/connections/connections.store.svelte', () => ({ connectionsStore: {} }))
mock.module('@solus/workspace-ui/contexts/projects/projects.store.svelte', () => ({
  projectsStore: {},
  CHATS_GROUP_KEY: 'solus:chats',
  groupKeyFor: (_serverId: string, projectKey: string) => projectKey,
}))
mock.module('@solus/workspace-ui/contexts/prs/session-pull-requests.store.svelte', () => ({ sessionPullRequestsStore: {}, sessionPrLink: () => null }))
const sessionListStore = {
  onRecordsRead: () => () => {},
  homeFor: (target: { serverId: string; sessionId: string }) => target.serverId,
  setSettled: async () => {},
  setArchived: async () => {},
}
mock.module('@solus/workspace-ui/contexts/workspace/session-list.store.svelte', () => ({ sessionListStore }))
mock.module('@solus/workspace-ui/lib/toasts', () => ({ toasts: { error: () => {}, undo: () => {} } }))
let SessionSidebarStore: typeof SidebarStore
beforeAll(async () => {
  ;({ SessionSidebarStore } = await import('@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'))
})

function sidebar() {
  const sessions = new Map<string, Pick<Session, 'prompt'>>([
    ['first', { prompt: makePrompt({ text: 'Follow up on the result' }) }],
    ['second', { prompt: makePrompt() }],
  ])
  const shown = new Set(['first'])
  const selected: string[] = []
  const store = Object.create(SessionSidebarStore.prototype) as SidebarStore
  Object.assign(store, {
    activeTasks: [
      { tabIds: ['first'] },
      { tabIds: ['second'] },
    ],
    session: {
      hasCompanionPanes: true,
      router: { panes: [{ id: 'lead' }, { id: 'aside' }] },
      chatTabIn: (paneId: string) => {
        const tabId = paneId === 'lead' ? 'first' : 'second'
        return shown.has(tabId) ? tabId : null
      },
      sessionFor: (tabId: string) => sessions.get(tabId),
      selectTab: (tabId: string) => selected.push(tabId),
    },
  })
  return { store, sessions, shown, selected }
}

describe('unsent prompts in open sidebar sessions', () => {
  test('moves to Drafts only after the conversation leaves the screen', () => {
    const { store, shown } = sidebar()
    expect([...store.parkedSessionTabIds]).toEqual([])
    shown.delete('first')
    expect([...store.parkedSessionTabIds]).toEqual(['first'])
    shown.add('first')
    expect([...store.parkedSessionTabIds]).toEqual([])
  })

  test('does not park a companion conversation or an empty prompt', () => {
    const { store, shown, sessions } = sidebar()
    shown.add('second')
    sessions.get('second')!.prompt.text = 'Keep typing beside the first session'
    expect([...store.parkedSessionTabIds]).toEqual([])
    shown.clear()
    sessions.get('first')!.prompt.text = ' \n '
    expect([...store.parkedSessionTabIds]).toEqual(['second'])
    sessions.get('second')!.prompt = makePrompt()
    expect([...store.parkedSessionTabIds]).toEqual([])
  })

  test('attachments earn a draft, linked to a task or not', () => {
    // WHY: a link to a task gives a session no row identity of its own, so a
    // set-aside prompt moves to Drafts like any other session's.
    const { store, shown, sessions } = sidebar()
    shown.clear()
    sessions.get('first')!.prompt.text = ''
    sessions.get('first')!.prompt.attachments.push({ id: 'file' } as Session['prompt']['attachments'][number])
    expect([...store.parkedSessionTabIds]).toEqual(['first'])
    Object.assign(store, {
      activeTasks: [{ tabIds: ['first'], linkedTask: { taskId: 'task', title: 'Task' } } satisfies Partial<SidebarTask>],
    })
    expect([...store.parkedSessionTabIds]).toEqual(['first'])
  })

  test('a session draft opens its original conversation', () => {
    const { store, selected } = sidebar()
    store.openDraftRow({ draftId: 'session:first', tabId: 'first' } as Parameters<SidebarStore['openDraftRow']>[0])
    expect(selected).toEqual(['first'])
  })

  test('discard clears only the prompt and Undo restores it without replacing newer text', () => {
    const { store, sessions } = sidebar()
    const previousState = globalThis.$state
    globalThis.$state = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value }) as typeof $state
    try {
      const row = { draftId: 'session:first', tabId: 'first' } as Parameters<SidebarStore['discardDraftRow']>[0]
      const original = sessions.get('first')!.prompt
      const undo = store.discardDraftRow(row)
      expect(sessions.size).toBe(2)
      expect(sessions.get('first')!.prompt.text).toBe('')
      undo!()
      expect(sessions.get('first')!.prompt).toEqual(original)
      const undoAgain = store.discardDraftRow(row)
      sessions.get('first')!.prompt.text = 'New work'
      undoAgain!()
      expect(sessions.get('first')!.prompt.text).toBe('New work')
    } finally {
      globalThis.$state = previousState
    }
  })
})


test('pins from a healthy host appear while another host is still loading', async () => {
  const slow = Promise.withResolvers<PinnedSession[]>()
  const pin: PinnedSession = {
    sessionId: 'healthy-session', provider: 'codex', title: 'Pinned session', cwd: '/repo', pinnedAt: 1,
  }
  connections.registerPrimary('local', { pinnedSessionsList: async () => [pin, pin] })
  connections.registerHost('slow', { pinnedSessionsList: () => slow.promise })
  const store = Object.create(SessionSidebarStore.prototype) as SidebarStore
  Object.defineProperty(store, 'pinRequests', { value: new Map<string, number>() })
  Object.defineProperty(store, 'pinsReadOn', { value: new WeakSet() })
  store.pinnedSessions = [{ ...pin, sessionId: 'old', serverId: 'slow' }]
  const load = store.loadPinnedSessions()
  await Promise.resolve()
  expect(store.pinnedSessions.map((row) => row.sessionId)).toEqual(['old', 'healthy-session'])
  slow.resolve([])
  await load
  expect(store.pinnedSessions.map((row) => row.sessionId)).toEqual(['healthy-session'])
})

test('completion and archive announcements remove host-scoped pins and invalidate stale reads', async () => {
  const pending = Promise.withResolvers<PinnedSession[]>()
  const pin: PinnedSession = { sessionId: 'session', serverId: 'local', provider: 'codex', title: 'Pinned', cwd: '/repo', pinnedAt: 1 }
  connections.registerPrimary('local', { pinnedSessionsList: () => pending.promise })
  connections.registerHost('other', { pinnedSessionsList: async () => [{ ...pin, serverId: 'other' }] })
  const store = Object.create(SessionSidebarStore.prototype) as SidebarStore
  Object.defineProperty(store, 'pinRequests', { value: new Map<string, number>() })
  Object.defineProperty(store, 'pinsReadOn', { value: new WeakSet() })
  store.pinnedSessions = [pin, { ...pin, serverId: 'other' }]
  const stop = store.subscribeSessionStatuses()
  try {
    const read = store.loadPinnedSessions()
    connections.eventsFor('local').receive({
      type: 'session.viewChanged',
      payload: { sessionId: 'session', view: { settledAt: 10, archivedAt: null, snoozedUntil: null, snoozeNote: null } },
      occurredAt: 10,
    })
    pending.resolve([pin])
    await read
    expect(store.pinnedSessions.map((held) => held.serverId)).toEqual(['other'])
    connections.eventsFor('other').receive({
      type: 'session.viewChanged',
      payload: { sessionId: 'session', view: { settledAt: null, archivedAt: 20, snoozedUntil: null, snoozeNote: null } },
      occurredAt: 20,
    })
    expect(store.pinnedSessions).toEqual([])
  } finally {
    stop()
  }
})

test('archiving a pinned session ends its pin, on its own host when the Solus API is its home', async () => {
  // WHY: an organization session's home is its Solus API, which holds no pins.
  // Unless the host that holds the pin removes it, the next manifest read puts
  // the archived session back in Pinned.
  const pin: PinnedSession = { sessionId: 'org-session', serverId: 'local', provider: 'codex', title: 'Pinned', cwd: '/repo', pinnedAt: 1 }
  const localPin: PinnedSession = { ...pin, sessionId: 'local-session' }
  const toggled: PinnedSession[] = []
  connections.registerPrimary('local', { togglePinnedSession: async (session: PinnedSession) => { toggled.push(session); return [] } })
  const store = Object.create(SessionSidebarStore.prototype) as SidebarStore
  Object.defineProperty(store, 'pinRequests', { value: new Map<string, number>() })
  Object.defineProperty(store, 'pinsReadOn', { value: new WeakSet() })
  store.pinnedSessions = [pin, localPin]
  const homeFor = sessionListStore.homeFor
  sessionListStore.homeFor = (target) => target.sessionId === 'org-session' ? 'solus-api:org' : target.serverId
  try {
    const archive = (store as unknown as { archiveOnHost(targets: { serverId: string; sessionId: string }[]): Promise<void> }).archiveOnHost
    await archive.call(store, [{ serverId: 'local', sessionId: 'org-session' }, { serverId: 'local', sessionId: 'local-session' }])
    await Promise.resolve()
    expect(store.pinnedSessions).toEqual([])
    // The local home removes its own pin; a toggle there would put it back.
    expect(toggled.map((session) => session.sessionId)).toEqual(['org-session'])
  } finally {
    sessionListStore.homeFor = homeFor
  }
})
