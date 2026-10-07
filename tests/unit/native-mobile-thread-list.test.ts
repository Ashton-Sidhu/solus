import { describe, expect, test } from 'bun:test'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import type { SessionPullRequestLink } from '@solus/contracts/session-pull-requests'
import type { SessionState } from '@solus/contracts/session-state'
import type { ProjectEntry, SessionRecord, SessionStatus } from '@solus/contracts/types'
import { buildHomeProjectScopes, sortHomeProjectScopes } from '../../apps/mobile/src/features/home/homeThreadList'
import { deriveWorkspaceState, workspaceConnectionStatusPresentation } from '../../apps/mobile/src/features/home/workspace-connection-status'
import { threadKey, type SolusProjectShell, type SolusThreadShell } from '../../apps/mobile/src/features/threads/thread-directory'
import { ThreadListState, type ThreadListConnection } from '../../apps/mobile/src/features/threads/thread-list-state'
import { resolveSnoozePresets, snoozeWakeLabel } from '../../apps/mobile/src/features/threads/thread-snooze'
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  presentThreadPullRequests,
  resolveThreadListV2Status,
  threadListV2ListItemsAreEqual,
  type ThreadListV2Facts,
} from '../../apps/mobile/src/features/threads/threadListV2'
import {
  resolveThreadSelectionNavigationAction,
  resolveThreadSelectionOverlayState,
} from '../../apps/mobile/src/lib/adaptive-navigation'
import { memoryKeyValueStore } from '../../apps/mobile/src/platform/ports'

const NOW = Date.UTC(2026, 9, 4, 12, 0)
const HOUR = 60 * 60 * 1000

function record(sessionId: string, extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId, organizationId: 'local', publication: 'local', ownerUserId: null, provider: 'claude-code',
    projectPath: '/repo', projectRemote: null, runnerHostId: null, title: `Session ${sessionId}`, customTitle: null,
    status: 'idle', model: null, reasoningEffort: null, parentSessionId: null, rootSessionId: null,
    createdAt: NOW - HOUR, lastActivityAt: NOW - HOUR, size: 0, cwd: '/repo', slug: null, isWorktree: false,
    branch: null, projectRoot: null, delegation: null, ...extra,
  }
}

function shell(hostId: string, sessionId: string, extra: Partial<SessionRecord> = {}): SolusThreadShell {
  return { key: threadKey(hostId, sessionId), hostId, hostLabel: hostId, record: record(sessionId, extra) }
}

function project(hostId: string, path: string, repositoryKey: string | null): SolusProjectShell {
  const entry: ProjectEntry = { key: path, path, folderName: path.split('/').at(-1)!, addedAt: '2026-01-01T00:00:00Z', repositoryKey }
  return { key: `${hostId}\u0000${path}`, hostId, hostLabel: hostId, project: entry }
}

function facts(input: { shelf?: Record<string, Partial<SessionState>>; live?: Record<string, SessionStatus>; prs?: Record<string, SessionPullRequestLink[]> } = {}): ThreadListV2Facts {
  return {
    shelf: new Map(Object.entries(input.shelf ?? {}).map(([key, state]) => [key, { sessionId: key, settledAt: null, settledBy: null, snoozedUntil: null, snoozeNote: null, ...state }])),
    liveStatus: new Map(Object.entries(input.live ?? {})),
    pullRequests: new Map(Object.entries(input.prs ?? {})),
  }
}

function link(number: number, extra: Partial<SessionPullRequestLink> = {}): SessionPullRequestLink {
  return { sessionId: 's', repository: 'github.com/a/b', number, url: `https://x/${number}`, title: `PR ${number}`, source: 'branch', linkedAt: number, ...extra }
}

describe('thread list partition', () => {
  const active = shell('h1', 'active', { createdAt: NOW - 2 * HOUR })
  const newer = shell('h1', 'newer', { createdAt: NOW - HOUR })
  const settled = shell('h1', 'settled')
  const snoozed = shell('h2', 'snoozed')
  const woken = shell('h2', 'woken', { createdAt: NOW - 1.5 * HOUR })
  const state = facts({
    shelf: {
      [settled.key]: { settledAt: NOW - HOUR },
      [snoozed.key]: { snoozedUntil: NOW + HOUR },
      [woken.key]: { snoozedUntil: NOW - 1 },
    },
  })

  test('settled sessions go to the Settled shelf, snoozed ones to Snoozed, and an ended snooze is active again', () => {
    const layout = buildThreadListV2Items({
      threads: [active, settled, snoozed, woken, newer], facts: state, hostId: null, searchQuery: '', now: NOW,
      snoozedShelfExpanded: true,
    })
    // Active keeps creation order, newest first, so a working thread never jumps.
    expect(layout.items.map((item) => [item.thread.record.sessionId, item.variant, item.snoozed])).toEqual([
      ['newer', 'card', false], ['woken', 'card', false], ['active', 'card', false],
      ['snoozed', 'slim', true], ['settled', 'slim', false],
    ])
    expect(layout).toMatchObject({ snoozedCount: 1, settledCount: 1, snoozedShelfHeaderIndex: 3, settledShelfHeaderIndex: 4, nextSnoozeWakeAt: NOW + HOUR })
  })

  test('a collapsed shelf keeps only the thread open beside it', () => {
    const layout = buildThreadListV2Items({
      threads: [active, settled, snoozed], facts: state, hostId: null, searchQuery: '', now: NOW,
      snoozedShelfExpanded: false, settledShelfExpanded: false, selectedThreadKey: settled.key,
    })
    expect(layout.items.map((item) => item.thread.key)).toEqual([active.key, settled.key])
    expect(layout.snoozedCount).toBe(1)
  })

  test('host, project, and search filters narrow the list; search also matches the branch and pull requests', () => {
    const onBranch = shell('h1', 'b', { branch: 'fix/login', title: 'Unrelated' })
    const withPr = shell('h1', 'p', { title: 'Other' })
    const elsewhere = shell('h2', 'e', { projectPath: '/other' })
    const withFacts = facts({ prs: { [withPr.key]: [link(42)] } })
    const run = (input: { hostId?: string | null; projectKeys?: Set<string> | null; searchQuery?: string }) =>
      buildThreadListV2Items({ threads: [onBranch, withPr, elsewhere], facts: withFacts, hostId: input.hostId ?? null, projectKeys: input.projectKeys ?? null, searchQuery: input.searchQuery ?? '', now: NOW })
        .items.map((item) => item.thread.record.sessionId)
    expect(run({ hostId: 'h2' })).toEqual(['e'])
    expect(run({ projectKeys: new Set(['h2\u0000/other']) })).toEqual(['e'])
    expect(run({ searchQuery: 'LOGIN' })).toEqual(['b'])
    expect(run({ searchQuery: '#42' })).toEqual(['p'])
  })

  test('settled history pages and reports what it hid', () => {
    const many = Array.from({ length: 5 }, (_, index) => shell('h1', `s${index}`))
    const shelf = facts({ shelf: Object.fromEntries(many.map((thread, index) => [thread.key, { settledAt: NOW - index }])) })
    const layout = buildThreadListV2Items({ threads: many, facts: shelf, hostId: null, searchQuery: '', now: NOW, settledLimit: 2 })
    expect(layout.items.map((item) => item.thread.record.sessionId)).toEqual(['s0', 's1'])
    expect(layout.hiddenSettledCount).toBe(3)
  })
})

describe('thread list rows', () => {
  test('the live status wins over the record; a record alone only knows running', () => {
    expect(resolveThreadListV2Status({ status: 'idle' }, 'awaiting_input')).toBe('input')
    expect(resolveThreadListV2Status({ status: 'idle' }, 'awaiting_plan')).toBe('approval')
    expect(resolveThreadListV2Status({ status: 'idle' }, 'rate_limited')).toBe('limited')
    expect(resolveThreadListV2Status({ status: 'idle' }, 'background')).toBe('waiting')
    expect(resolveThreadListV2Status({ status: 'running' }, 'completed')).toBe('ready')
    expect(resolveThreadListV2Status({ status: 'running' }, undefined)).toBe('working')
    expect(resolveThreadListV2Status({ status: 'interrupted' }, undefined)).toBe('ready')
  })

  test('shelf headers splice between sections and hairlines stop at a header', () => {
    const a = shell('h', 'a')
    const b = shell('h', 'b')
    const settled = shell('h', 's')
    const state = facts({ shelf: { [settled.key]: { settledAt: NOW } }, live: { [a.key]: 'awaiting_input' } })
    const layout = buildThreadListV2Items({ threads: [a, b, settled], facts: state, hostId: null, searchQuery: '', now: NOW })
    const items = buildThreadListV2ListItems({ ...layout, items: layout.items, facts: state, now: NOW })
    expect(items.map((item) => item.type)).toEqual(['v2-thread', 'v2-thread', 'v2-settled-shelf', 'v2-thread'])
    expect(items.map((item) => item.type === 'v2-thread' && item.showTrailingDivider)).toEqual([true, false, false, false])
    const first = items[0]!
    // A blocked thread may not be snoozed, and its status label replaces the time.
    expect(first.type === 'v2-thread' && [first.status, first.snoozePresetMinute, first.timeLabel]).toEqual(['input', undefined, ''])
  })

  test('a reload with the same facts does not re-render a row; a status change does', () => {
    const before = shell('h', 'a')
    const after = { ...shell('h', 'a') }
    const build = (thread: SolusThreadShell, live: Record<string, SessionStatus> = {}) => {
      const state = facts({ live })
      const layout = buildThreadListV2Items({ threads: [thread], facts: state, hostId: null, searchQuery: '', now: NOW })
      return buildThreadListV2ListItems({ items: layout.items, facts: state, now: NOW })[0]!
    }
    expect(threadListV2ListItemsAreEqual(build(before), build(after))).toBe(true)
    expect(threadListV2ListItemsAreEqual(build(before), build(after, { [after.key]: 'running' }))).toBe(false)
  })

  test('the pull request badge prefers the newest open link and counts several', () => {
    expect(presentThreadPullRequests(undefined)).toBeNull()
    expect(presentThreadPullRequests([link(7, { missing: true })])).toBeNull()
    const pending = presentThreadPullRequests([link(7)])
    expect(pending).toMatchObject({ label: '7', state: null, textClassName: 'text-foreground-muted' })
    const snapshot = (state: 'open' | 'closed' | 'merged', draft = false) => ({ number: 0, url: '', title: '', state, draft, updatedAt: '', baseRepo: { host: '', owner: '', repo: '' } })
    const several = presentThreadPullRequests([link(1, { snapshot: snapshot('merged') }), link(2, { snapshot: snapshot('open') }), link(3, { snapshot: snapshot('closed') })])
    expect(several).toMatchObject({ number: 2, state: 'open', label: '+3' })
    expect(presentThreadPullRequests([link(5, { snapshot: snapshot('open', true) })])).toMatchObject({ isDraft: true, textClassName: 'text-foreground-muted' })
  })

  test('snooze presets wake in the future and the wake label rounds up', () => {
    const now = new Date(2026, 9, 7, 10, 0) // a Wednesday
    const presets = resolveSnoozePresets(now)
    expect(presets.map((preset) => preset.id)).toEqual(['hour', 'three-hours', 'evening', 'tomorrow', 'next-week'])
    expect(presets.every((preset) => preset.snoozedUntil > now.getTime())).toBe(true)
    // Evening is only offered while it is more than an hour away.
    expect(resolveSnoozePresets(new Date(2026, 9, 7, 17, 30)).some((preset) => preset.id === 'evening')).toBe(false)
    // On a Sunday, Tomorrow and Next week are the same Monday morning.
    expect(resolveSnoozePresets(new Date(2026, 9, 4, 10, 0)).some((preset) => preset.id === 'next-week')).toBe(false)
    expect(snoozeWakeLabel(NOW + 30_001, NOW)).toBe('1m')
    expect(snoozeWakeLabel(NOW + 2 * HOUR, NOW)).toBe('2h')
    expect(snoozeWakeLabel(NOW + 49 * HOUR, NOW)).toBe('3d')
    expect(snoozeWakeLabel(NOW - 1, NOW)).toBe('now')
  })
})

describe('home project filter', () => {
  test('one repository on two hosts is one scope; a folder with no remote is its own', () => {
    const projects = [project('h1', '/a', 'github.com/o/a'), project('h2', '/src/a', 'github.com/o/a'), project('h1', '/notes', null)]
    const scopes = buildHomeProjectScopes({ projects, hostId: null })
    expect(scopes.map((scope) => [scope.title, scope.projects.length])).toEqual([['a', 2], ['notes', 1]])
    expect(buildHomeProjectScopes({ projects, hostId: 'h2' }).map((scope) => scope.projects.length)).toEqual([1])
    // The Home filter and the new-task picker name one project by one key.
    expect(scopes.map((scope) => scope.key)).toEqual(['github.com/o/a', 'h1:/notes'])
    // The project with the newest thread comes first; a session in a worktree counts toward its git root.
    const known = new Set(projects.map((entry) => entry.key))
    const thread = shell('h1', 't', { projectPath: '/notes/.worktrees/x', projectRoot: '/notes', lastActivityAt: NOW })
    expect(sortHomeProjectScopes({ scopes, threads: [thread], knownProjectKeys: known }).map((scope) => scope.title)).toEqual(['notes', 'a'])
  })

  test('a name two projects share is told apart only among the projects the host filter keeps', () => {
    const projects = [project('h1', '/x/a', 'github.com/o/a'), project('h2', '/y/a', 'github.com/p/a')]
    expect(buildHomeProjectScopes({ projects, hostId: null }).map((scope) => scope.title)).toEqual(['o/a', 'p/a'])
    expect(buildHomeProjectScopes({ projects, hostId: 'h2' }).map((scope) => scope.title)).toEqual(['a'])
  })
})

describe('workspace connection status', () => {
  const loaded = { kind: 'loaded', value: { threads: [], projects: [], indexing: false } } as const
  test('connected hosts with read lists show nothing; a reconnect names the host', () => {
    expect(workspaceConnectionStatusPresentation(deriveWorkspaceState([{ label: 'Mac', phase: 'connected', threads: loaded }]))).toBeNull()
    expect(workspaceConnectionStatusPresentation(deriveWorkspaceState([{ label: 'Mac', phase: 'reconnecting', threads: loaded }])))
      .toEqual({ label: 'Reconnecting to Mac', showsProgress: true })
    expect(workspaceConnectionStatusPresentation(deriveWorkspaceState([{ label: 'Mac', phase: 'offline', threads: loaded }])))
      .toEqual({ label: 'Not connected', showsProgress: false })
    expect(workspaceConnectionStatusPresentation(deriveWorkspaceState([{ label: 'Mac', phase: 'connected', threads: { kind: 'loading', previous: null } }])))
      .toEqual({ label: 'Loading threads...', showsProgress: true })
  })
})

describe('thread selection', () => {
  test('a compact list and Home push; the split sidebar sets the open thread in place', () => {
    expect(resolveThreadSelectionNavigationAction({ usesSplitView: false, routeName: 'Thread' })).toBe('push')
    expect(resolveThreadSelectionNavigationAction({ usesSplitView: true, routeName: 'Home' })).toBe('push')
    expect(resolveThreadSelectionNavigationAction({ usesSplitView: true, routeName: 'Thread' })).toBe('set-params')
    expect(resolveThreadSelectionNavigationAction({ usesSplitView: true, routeName: 'Files' })).toBe('replace')
  })

  test('selecting from under a sheet dismisses it and opens the thread in one update', () => {
    const state = {
      key: 'stack', index: 2, routeNames: [], type: 'stack', stale: false as const,
      routes: [{ key: 'home', name: 'Home' }, { key: 'thread', name: 'Thread', params: { hostId: 'h', sessionId: 'old' } }, { key: 'settings', name: 'Settings' }],
    }
    const next = resolveThreadSelectionOverlayState({ state, workspaceRouteKey: 'thread', action: 'set-params', params: { hostId: 'h', sessionId: 'new' } })
    expect(next?.routes.map((route) => [route.name, route.params])).toEqual([
      ['Home', undefined], ['Thread', { hostId: 'h', sessionId: 'new' }],
    ])
    expect(resolveThreadSelectionOverlayState({ state: { ...state, index: 1 }, workspaceRouteKey: 'thread', action: 'set-params', params: { hostId: 'h', sessionId: 'new' } })).toBeNull()
  })
})

describe('thread list state', () => {
  function fakeConnection() {
    const events = new HostEventSubscriber()
    const calls: string[] = []
    let shelf: SessionState[] = [{ sessionId: 's1', settledAt: NOW, settledBy: 'person', snoozedUntil: null, snoozeNote: null }]
    const connection: ThreadListConnection = {
      events,
      onReset: () => () => {},
      api: {
        sessionShelfList: async (ids?: string[]) => {
          calls.push(`shelf:${ids?.join(',') ?? '*'}`)
          return shelf.filter((entry) => !ids || ids.includes(entry.sessionId)).map((entry) => ({ ...entry, title: null, projectPath: null }))
        },
        sessionPullRequestsList: async () => ({ s2: [link(9)] }),
        sessionSetSettled: async (sessionId: string, settled: boolean) => {
          calls.push(`settle:${sessionId}:${settled}`)
          shelf = shelf.filter((entry) => entry.sessionId !== sessionId)
          if (settled) shelf.push({ sessionId, settledAt: NOW, settledBy: 'person', snoozedUntil: null, snoozeNote: null })
        },
        sessionSnooze: async () => {},
        setSessionTitle: async () => {},
      },
    }
    return { events, calls, connection }
  }

  test('reads the shelf and links, follows live status, and re-reads one session after a change', async () => {
    const host = fakeConnection()
    const list = new ThreadListState(() => host.connection, memoryKeyValueStore())
    await list.load('h')
    expect(list.facts().shelf.get(threadKey('h', 's1'))?.settledAt).toBe(NOW)
    expect(list.facts().pullRequests.get(threadKey('h', 's2'))?.[0]?.number).toBe(9)

    host.events.receive({ type: 'session.statusChanged', payload: { sessionId: 's2', agentSessionId: 'p2', status: 'awaiting_input', at: NOW }, occurredAt: NOW })
    expect(list.facts().liveStatus.get(threadKey('h', 's2'))).toBe('awaiting_input')
    expect(list.facts().liveStatus.get(threadKey('h', 'p2'))).toBe('awaiting_input')

    await list.setSettled('h', 's1', false)
    expect(host.calls).toEqual(['shelf:*', 'settle:s1:false', 'shelf:s1'])
    expect(list.facts().shelf.has(threadKey('h', 's1'))).toBe(false)
  })

  test('shelf expansion survives a new app on the same device', () => {
    const storage = memoryKeyValueStore()
    const first = new ThreadListState(() => null, storage)
    expect(first.shelfExpansion()).toEqual({ snoozed: false, settled: false })
    first.toggleShelf('settled')
    expect(new ThreadListState(() => null, storage).shelfExpansion()).toEqual({ snoozed: false, settled: true })
  })
})
