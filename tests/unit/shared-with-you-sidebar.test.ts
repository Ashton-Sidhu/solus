import { describe, expect, spyOn, test } from 'bun:test'
import { asHostApi } from '@solus/client-core/host-api'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { serverConnections } from '@solus/client-core/server-connections'
import type { HubNotification } from '@solus/contracts/notification-hub'
import { sessionMetaFromRecord } from '@solus/contracts/session-record-meta'
import type { SessionRecord } from '@solus/contracts/types'
import { notificationDestination } from '@solus/workspace-ui/components/notifications/lib/notification-actions'
import { buildSidebarListItems } from '@solus/workspace-ui/components/session/lib/sidebar-list-items'
import { sidebarSectionOf, sortSharedRows, type SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'
import { SessionListStore, type ListedSession } from '@solus/workspace-ui/contexts/workspace/session-list.store.svelte'
import { SessionSidebarStore } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'
import {
  isUnopenedShare,
  newGrants,
  sessionShareOf,
  unopenableSessionNotice,
  type SessionShare,
} from '@solus/workspace-ui/contexts/workspace/shared-sessions'

// Shared with you (docs/plans/shared-with-you.md): a session another person
// owns is in its own section of the sidebar, and a new direct share tells the
// reader once.

const share = (fields: Partial<SessionShare> = {}): SessionShare =>
  ({ ownerKey: 'user:ana', role: 'editor', sharedBy: 'user:ana', grantedAt: 100, lastActivityAt: 50, ...fields })

function row(id: string, fields: Partial<SidebarTask> = {}): SidebarTask {
  return { id, key: id, title: id, tabIds: [], status: 'idle', lifecycle: 'active', ...fields } as SidebarTask
}

const record = (sessionId: string, fields: Partial<SessionRecord> = {}) =>
  ({ sessionId, title: sessionId, customTitle: null, slug: null, projectRoot: '/repo', projectPath: '-repo', createdAt: 1, lastActivityAt: 10, organizationId: 'local', ownerKey: 'user:me', role: 'owner', state: null, view: null, listed: true, pullRequests: [], ...fields }) as SessionRecord

describe('the section a row is in', () => {
  test('another person\'s session is in Shared with you in every state, never in the reader\'s own sections', () => {
    // WHY: rule 1 — the owner decides the section. A shared session that runs,
    // that its owner settled, that is snoozed, or that is open in a tab must not
    // mix with the reader's own Sessions, Working, Snoozed, or Completed.
    expect(sidebarSectionOf(row('idle', { share: share() }))).toBe('shared')
    expect(sidebarSectionOf(row('running', { share: share(), status: 'running' }))).toBe('shared')
    expect(sidebarSectionOf(row('open-tab', { share: share(), tabIds: ['tab-1'], status: 'running' }))).toBe('shared')
    expect(sidebarSectionOf(row('settled', { share: share(), lifecycle: 'completed', status: 'done' }))).toBe('shared')
    expect(sidebarSectionOf(row('snoozed', { share: share(), lifecycle: 'snoozed' }))).toBe('shared')
  })

  test('the reader\'s own rows keep their sections', () => {
    expect(sidebarSectionOf(row('mine'))).toBe('sessions')
    expect(sidebarSectionOf(row('busy', { status: 'running' }))).toBe('working')
    expect(sidebarSectionOf(row('task-chip', { taskId: 'task', status: 'running' }))).toBe('working')
    expect(sidebarSectionOf(row('later', { lifecycle: 'snoozed' }))).toBe('snoozed')
    expect(sidebarSectionOf(row('done', { lifecycle: 'completed' }))).toBe('completed')
  })

  test('rows go newest grant first, and a session no direct share gave goes by its activity', () => {
    const rows = sortSharedRows([
      row('old', { share: share({ grantedAt: 10 }) }),
      row('opened-from-link', { share: share({ grantedAt: null, sharedBy: null, lastActivityAt: 60 }) }),
      row('new', { share: share({ grantedAt: 200 }) }),
    ])
    expect(rows.map((shared) => shared.id)).toEqual(['new', 'opened-from-link', 'old'])
  })

  test('the section sits between Sessions and Working, with a header and a count', () => {
    const items = buildSidebarListItems({
      drafts: [],
      sessions: [row('mine')],
      shared: [row('theirs', { share: share() })],
      working: [row('busy', { status: 'running' })],
      snoozed: [],
      completed: [],
      isSharedOpen: true,
      isWorkingOpen: true,
      isSnoozedOpen: false,
      isCompletedOpen: false,
      shelfRevealTaskId: null,
    })
    expect(items.map((item) => item.key)).toEqual([
      'mine:card', 'header:shared', 'theirs:card', 'header:working', 'busy:card',
    ])
    expect(items.find((item) => item.key === 'header:shared')).toMatchObject({ count: 1, isOpen: true })
  })
})

describe('a listed session\'s row', () => {
  type Harness = { session: unknown; lifecycleNow: number; buildListedSessionRow(listed: ListedSession): SidebarTask }
  const listed = (sessionId: string): ListedSession => ({
    serverId: 'host', homeServerId: 'host', runnerOffline: false, sessionId, title: sessionId, projectPath: '/repo', createdAt: 1,
    opensWith: { provider: 'claude', projectPath: '-repo', cwd: '/repo' }, share: share(),
  })

  test('a listed shared session is in Shared with you, with its task chip kept', () => {
    // WHY: every row is a session; a task linked to it is a chip, not a place
    // the row moves to, so the share still decides the section.
    const store = Object.create(SessionSidebarStore.prototype) as Harness
    store.lifecycleNow = 0
    store.session = { tasksStore: { taskForSession: (sessionId: string) => sessionId === 'linked' ? { id: 'task', title: 'Task' } : undefined } }
    const linked = store.buildListedSessionRow(listed('linked'))
    expect(sidebarSectionOf(linked)).toBe('shared')
    expect(linked.linkedTask).toEqual({ taskId: 'task', title: 'Task' })
    const loose = store.buildListedSessionRow(listed('loose'))
    expect(sidebarSectionOf(loose)).toBe('shared')
    // Never opened: the row carries the unread dot.
    expect(loose.unread).toBe(true)
  })
})

describe('the share a record stands for', () => {
  test('only another person\'s session is shared', () => {
    expect(sessionShareOf(record('mine'))).toBeUndefined()
    expect(sessionShareOf(record('old-host', { role: undefined }))).toBeUndefined()
    expect(sessionShareOf(record('theirs', { ownerKey: 'user:ana', role: 'viewer', sharedBy: 'user:ana', grantedAt: 5 })))
      .toEqual({ ownerKey: 'user:ana', role: 'viewer', sharedBy: 'user:ana', grantedAt: 5, lastActivityAt: 10 })
    // The picker marks the same sessions.
    expect(sessionMetaFromRecord(record('theirs', { ownerKey: 'user:ana', role: 'viewer' })).shared).toBe(true)
    expect(sessionMetaFromRecord(record('mine')).shared).toBeUndefined()
  })

  test('a row is new until the reader opens it, and new again after a later grant', () => {
    expect(isUnopenedShare(share({ grantedAt: 100 }), undefined)).toBe(true)
    expect(isUnopenedShare(share({ grantedAt: 100 }), 100)).toBe(false)
    expect(isUnopenedShare(share({ grantedAt: 200 }), 100)).toBe(true)
    // Opened from a link or an organization share: the reader went there.
    expect(isUnopenedShare(share({ grantedAt: null }), undefined)).toBe(false)
  })
})

describe('a new share tells the reader once', () => {
  test('grants older than the mark do not toast; each newer grant does, once', () => {
    // WHY: on boot the first read lists every share the reader got while the
    // app was closed; a toast for each would bury the composer.
    const first = newGrants([{ share: share({ grantedAt: 50 }) }, { share: share({ grantedAt: 150 }) }, {}], 100)
    expect(first.granted).toHaveLength(1)
    expect(first.seenUntil).toBe(150)
    expect(newGrants([{ share: share({ grantedAt: 150 }) }], first.seenUntil).granted).toHaveLength(0)
    // A higher role is a new grant.
    expect(newGrants([{ share: share({ grantedAt: 300 }) }], first.seenUntil).granted).toHaveLength(1)
  })

  test('the list store keeps a mark per host and reads again when a session share changes', async () => {
    const events = new HostEventSubscriber()
    let records = [record('before-start', { ownerKey: 'user:ana', role: 'editor', sharedBy: 'user:ana', grantedAt: 50 })]
    let reads = 0
    const api = spyOn(serverConnections, 'apiFor').mockReturnValue(asHostApi({
      sessionRecordList: async () => { reads++; return { records, indexing: false } },
    }))
    const subscribe = spyOn(serverConnections, 'eventsFor').mockReturnValue(events)
    const store = new SessionListStore({ connectedRunnerFor: () => null, connectedServerIds: () => ['host'] }, 100)
    const toasted: string[] = []
    store.onNewShares((granted) => toasted.push(...granted.map((listed) => listed.sessionId)))
    try {
      await store.load()
      expect(store.listed('before-start')?.share?.ownerKey).toBe('user:ana')
      expect(toasted).toEqual([])

      records = [...records, record('new', { ownerKey: 'user:ana', role: 'viewer', sharedBy: 'user:ana', grantedAt: 200 })]
      events.receive({ type: 'share.changed', payload: { resource: { kind: 'session', id: 'new' }, removedUserIds: [] }, occurredAt: 1 })
      await Promise.resolve()
      await Promise.resolve()
      expect(reads).toBe(2)
      expect(toasted).toEqual(['new'])

      // Access removed: the row leaves, and the client still knows whose it was.
      records = records.filter((listed) => listed.sessionId !== 'new')
      await store.load()
      expect(store.listed('new')).toBeUndefined()
      expect(store.shareFacts('new')?.share.ownerKey).toBe('user:ana')
      expect(toasted).toEqual(['new'])
    } finally { api.mockRestore(); subscribe.mockRestore() }
  })
})

describe('a session that does not open', () => {
  test('no access names the owner and the session, never the host; offline is a different state', () => {
    expect(unopenableSessionNotice({ isHostConnected: true, ownerName: 'Ana', title: 'Fix login' })).toEqual({
      message: "You don't have access to this session",
      description: 'Ana owns Fix login. Ask them to share it with you.',
    })
    expect(unopenableSessionNotice({ isHostConnected: true, ownerName: null, title: null }).message)
      .toBe("You don't have access to this session")
    expect(unopenableSessionNotice({ isHostConnected: false, ownerName: 'Ana', title: 'Fix login' }))
      .toEqual({ message: "Ana's computer is offline" })
  })

  test('a share notification opens the session it names', () => {
    const notification = { resource: { kind: 'session', sessionId: 's1' }, summary: { title: 'Fix login' } } as HubNotification
    expect(notificationDestination(notification, 'host:laptop').route).toEqual({ kind: 'session', sessionId: 's1', serverId: 'host:laptop' })
  })
})
