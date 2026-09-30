import { describe, expect, test } from 'bun:test'
import type { Task, TaskStatus } from '@solus/contracts/task-types'
import type { SessionMeta, SessionSearchResult } from '@solus/contracts/types'
import type { SidebarSessionChild } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'
import {
  buildPickerRows,
  pickerSessionTaskTitle,
  type PickerEntry,
} from '@solus/workspace-ui/components/session/unified-picker/lib/picker-rows'
import { nameScore } from '@solus/workspace-ui/components/session/unified-picker/lib/picker-relevance'
import type { PickerSort } from '@solus/workspace-ui/components/session/unified-picker/lib/picker-search'

const NOW = 1_800_000_000_000
const DAY = 86_400_000

function task(id: string, title: string, options: { ageDays?: number; status?: TaskStatus; shortId?: number; body?: string } = {}): Task {
  const updatedAt = NOW - (options.ageDays ?? 0) * DAY
  return {
    id, title, body: options.body ?? '', status: options.status ?? 'in_progress', shortId: options.shortId,
    priority: null, projectKey: 'solus', providerId: 'local', createdAt: updatedAt, updatedAt,
  } as unknown as Task
}

function child(sessionId: string, label: string, ageDays = 0): SidebarSessionChild {
  return {
    sessionId, label, branchName: null, attention: null, unread: false, serverId: 'local',
    runStartedAt: 0, lastActivityAt: NOW - ageDays * DAY, reviewGuideStatus: null,
  }
}

function orphan(sessionId: string, firstMessage: string): SessionSearchResult {
  const session = { sessionId, firstMessage, serverId: 'local', lastTimestamp: new Date(NOW).toISOString() } as SessionMeta
  return { session, snippet: firstMessage, ts: NOW, messageId: 1, rank: -1 }
}

function build(
  tasks: Task[],
  sessions: Record<string, SidebarSessionChild[]>,
  query: string,
  options: { sort?: PickerSort; conversations?: SessionSearchResult[] } = {},
) {
  return buildPickerRows({
    tasks: tasks.toSorted((a, b) => b.updatedAt - a.updatedAt),
    query,
    now: NOW,
    sort: options.sort,
    conversations: options.conversations,
    sessionsFor: (item) => sessions[item.id] ?? [],
    expandedTaskIds: new Set(),
  })
}

const idOf = (entry: PickerEntry) =>
  entry.kind === 'task' ? entry.task.id : entry.kind === 'session' ? entry.session.sessionId : entry.meta.sessionId

describe('picker relevance', () => {
  test('a title that is the query beats newer titles that only contain it', () => {
    // WHY: every title hit ranked the same and recency broke the tie, so the
    // task called "Onboarding" sat under every newer "Polish onboarding …".
    const tasks = [task('exact', 'Onboarding', { ageDays: 60 }), ...Array.from({ length: 8 }, (_, i) => task(`long-${i}`, `Polish onboarding copy ${i}`, { ageDays: i }))]
    expect(idOf(build(tasks, {}, 'onboarding').entries[0]!)).toBe('exact')
  })

  test('a whole word beats a word it only starts', () => {
    // WHY: "tab" is the tab strip, not the newer table work that shares its first letters.
    const tasks = [task('tab', 'Tab strip overflow', { ageDays: 30 }), ...Array.from({ length: 5 }, (_, i) => task(`table-${i}`, `Fix table export ${i}`, { ageDays: i }))]
    expect(idOf(build(tasks, {}, 'tab').entries[0]!)).toBe('tab')
  })

  test('recency still decides between equal names, and open work leads closed work', () => {
    const tasks = [task('done', 'Update dependencies', { ageDays: 1, status: 'done' }), task('open', 'Update dependencies', { ageDays: 3 })]
    expect(build(tasks, {}, 'update dep').entries.map(idOf)).toEqual(['open', 'done'])
  })

  test('a task\'s exact id comes first', () => {
    const tasks = [task('forty-two', 'Unrelated', { shortId: 42, ageDays: 90 }), task('four-two-one', 'Other', { shortId: 421 })]
    expect(idOf(build(tasks, {}, 'T-42').entries[0]!)).toBe('forty-two')
  })

  test('a name scores by how much of it the query is, not only whether it matches', () => {
    expect(nameScore('Websocket reconnect loop', ['websocket', 'reconnect'])).toBeGreaterThan(nameScore('Fix websocket sidebar after reconnect', ['websocket', 'reconnect']))
    expect(nameScore('Dark mode', ['dark', 'mode'])).toBeGreaterThan(nameScore('Dark mode for the settings page', ['dark', 'mode']))
  })
})

describe('picker top hits', () => {
  // Fourteen task titles hold both words; the session is named for them.
  const noise = Array.from({ length: 14 }, (_, i) => task(`noise-${i}`, `Fix websocket sidebar after reconnect ${i}`, { ageDays: i }))
  const owner = task('owner', 'Investigate flaky e2e runs', { ageDays: 25 })
  const sessions = { owner: [child('target', 'Websocket reconnect loop', 25)] }

  test('a session named for the query is lifted above every task that only matched', () => {
    // WHY: the Tasks section came first whatever the match, so the session the
    // reader named sat under fourteen weaker task hits.
    const { rows, entries } = build([...noise, owner], sessions, 'websocket reconnect')
    expect(rows[0]).toMatchObject({ kind: 'header', label: 'Top hits' })
    expect(idOf(entries[0]!)).toBe('target')
    // Listed once: lifted rows leave their sections.
    expect(entries.filter((entry) => idOf(entry) === 'target')).toHaveLength(1)
    expect(rows.find((row) => row.kind === 'header' && row.label === 'Sessions')).toBeUndefined()
  })

  test('no Top hits while the sections already open on the best rows', () => {
    const { rows } = build([owner, task('other', 'Websocket docs')], sessions, 'websocket')
    expect(rows.some((row) => row.kind === 'header' && row.label === 'Top hits')).toBe(false)
  })

  test('newest first lists the sections as they are', () => {
    const { rows } = build([...noise, owner], sessions, 'websocket reconnect', { sort: 'recency' })
    expect(rows[0]).toMatchObject({ kind: 'header', label: 'Tasks' })
  })

  test('a session is not lifted beside its own task', () => {
    // WHY: a task and the session named after it are one thing to the reader;
    // the task's row resumes that session, so the second row spent a place.
    const tray = task('tray', 'Tray icon blurry', { ageDays: 20 })
    const trayNoise = Array.from({ length: 6 }, (_, i) => task(`tray-${i}`, `Fix the tray icon when blurry ${i}`, { ageDays: i }))
    const traySessions = { tray: [child('tray-session', 'Tray icon blurry', 20)], 'tray-0': [child('other', 'Tray icon blurry again', 0)] }
    const { rows, entries } = build([tray, ...trayNoise], traySessions, 'tray icon blurry')
    expect(rows[0]).toMatchObject({ kind: 'header', label: 'Top hits' })
    const top = entries.slice(0, (rows[0] as { count: number }).count)
    expect(top.map(idOf)).toEqual(['tray', 'other', 'tray-0'])
    expect(top.map(idOf)).not.toContain('tray-session')
  })

  test('a session no task claims is a name hit when its words are in its name', () => {
    const named = orphan('named', 'what we said first')
    named.session.customTitle = 'Websocket reconnect loop notes'
    const { entries } = build([...noise], {}, 'websocket reconnect', { conversations: [named] })
    expect(idOf(entries[0]!)).toBe('named')
  })

  test('an opening message is what was said, not a name', () => {
    // WHY: a session with no title shows its opening message in its place. A
    // long message that happens to hold the words outranked sessions and
    // tasks that were named for them (docs/plans/unified-search.md §3).
    const { entries } = build([...noise], {}, 'websocket reconnect', { conversations: [orphan('untitled', 'Websocket reconnect loop notes')] })
    expect(idOf(entries[0]!)).not.toBe('untitled')
  })
})

describe('flat session rows', () => {
  test('name their task unless they are named after it', () => {
    const owner = task('owner', 'Investigate flaky e2e runs')
    const { entries } = build([owner], { owner: [child('a', 'Websocket loop'), child('b', 'Investigate flaky e2e runs')] }, 'e2e', { sort: 'recency' })
    const titles = entries.flatMap((entry) => entry.kind === 'session' ? [[entry.session.sessionId, pickerSessionTaskTitle(entry)]] : [])
    expect(titles).toEqual([['b', null]])
    const byName = build([owner], { owner: [child('a', 'Websocket loop')] }, 'websocket').entries[0]!
    if (byName.kind === 'task') throw new Error('expected a session row')
    expect(pickerSessionTaskTitle(byName)).toBe('Investigate flaky e2e runs')
  })
})
