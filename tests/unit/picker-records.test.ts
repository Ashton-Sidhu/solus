import { describe, expect, test } from 'bun:test'
import { SearchQuery } from '@solus/contracts/search-query'
import type { PullRequest } from '@solus/contracts/providers'
import type { Task } from '@solus/contracts/task-types'
import type { Automation, SessionMeta } from '@solus/contracts/types'
import type { SidebarSessionChild } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'
import { PR_LIST_ROW_HEIGHT } from '@solus/workspace-ui/components/prs/lib/prs-list-view'
import type { ListProjectOption } from '@solus/workspace-ui/components/ui/list-page/list-page'
import type { WorkspaceItem } from '@solus/workspace-ui/components/workspace/lib/workspace-items'
import { pickerEmptyMessage, pickerListLoading, type PickerEmptyState } from '@solus/workspace-ui/components/session/unified-picker/lib/picker-empty'
import { NO_PICKER_FILTERS } from '@solus/workspace-ui/components/session/unified-picker/lib/picker-filters'
import {
  matchRecord,
  recordKey,
  type PickerRecord,
} from '@solus/workspace-ui/components/session/unified-picker/lib/picker-records'
import { automationRecords, entryOpenLabel, hasActionBar, recordDetail, workPreviewBody } from '@solus/workspace-ui/components/session/unified-picker/lib/picker-record-view'
import {
  adjacentResultType,
  PICKER_RESULT_TYPES,
  type PickerResultType,
} from '@solus/workspace-ui/components/session/unified-picker/lib/picker-result-types'
import { hasRowMenu, rowMenuFor } from '@solus/workspace-ui/components/session/unified-picker/lib/picker-row-menu'
import {
  buildPickerRows,
  pickerCountLabel,
  pickerRowHeight,
  RECENTS_SHOWN,
  type PickerEntry,
  type PickerRowsInput,
} from '@solus/workspace-ui/components/session/unified-picker/lib/picker-rows'

const NOW = Date.UTC(2026, 10, 11)
const DAY = 86_400_000

function task(id: string, title: string): Task {
  return {
    id, providerId: 'github', kind: 'issue', title, body: '', url: null,
    state: { name: 'In progress', category: 'active' }, category: 'active', placements: [], labels: [], writableFields: [],
    createdAt: NOW, updatedAt: NOW,
  }
}

function child(sessionId: string, label: string, ageDays = 0): SidebarSessionChild {
  return {
    sessionId, label, branchName: null, attention: null, unread: false, serverId: 'local',
    runStartedAt: 0, lastActivityAt: NOW - ageDays * DAY, reviewGuideStatus: null,
  }
}

function recent(sessionId: string, ageDays: number, customTitle: string | null = null): SessionMeta {
  return { sessionId, serverId: 'local', customTitle, firstMessage: `opening of ${sessionId}`, lastTimestamp: new Date(NOW - ageDays * DAY).toISOString() } as SessionMeta
}

function work(id: string, title: string, options: { ageDays?: number; snippet?: string; projectKey?: string } = {}): PickerRecord {
  const timestamp = NOW - (options.ageDays ?? 0) * DAY
  const item = {
    id, rowKey: `work:${id}`, type: 'doc', glyph: 'doc', title, snippet: options.snippet ?? '', timestamp, createdAt: timestamp,
    projectKey: options.projectKey ?? 'github.com/acme/solus', projectLabel: 'solus', cwd: '/repo',
  } as WorkspaceItem
  return { type: 'work', item }
}

function automation(id: string, name: string, prompt = '', ageDays = 0): Automation {
  return {
    id, name, enabled: true, trigger: { type: 'manual' },
    action: { prompt, agentProvider: 'claude-code', modelId: null, reasoningEffort: 'medium', cwd: '/repo' },
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW - ageDays * DAY).toISOString(),
  } as Automation
}

function pullRequest(number: number, title: string, options: { hostMatched?: boolean; headRef?: string; state?: PullRequest['state'] } = {}): PickerRecord {
  const pr = {
    number, title, url: `https://github.com/acme/solus/pull/${number}`, author: 'mona', headRef: options.headRef ?? 'feature',
    baseRef: 'main', state: options.state ?? 'open', draft: false, updatedAt: new Date(NOW).toISOString(),
    labels: [], additions: 0, deletions: 0, authorAvatarUrl: '',
    baseRepo: { host: 'github.com', owner: 'acme', repo: 'solus' },
  } as PullRequest
  return { type: 'pullRequest', found: { pullRequest: pr, serverId: 'local', projectRoot: '/repo', projectLabel: 'solus' }, hostMatched: options.hostMatched ?? false }
}

function project(key: string, label: string, projectKey = `/Users/me/${label}`): PickerRecord {
  const option: ListProjectOption = { key, projectKey, serverId: 'local', label, available: true }
  return { type: 'project', project: option }
}

function build(input: Partial<PickerRowsInput>) {
  return buildPickerRows({ tasks: [], query: '', sessionsFor: () => [], now: NOW, ...input })
}

const titleOf = (entry: PickerEntry) =>
  entry.kind === 'record' ? recordKey(entry.record)
    : entry.kind === 'task' ? `task:${entry.task.id}`
      : entry.kind === 'session' ? `session:${entry.session.sessionId}` : `session:${entry.meta.sessionId}`
const headers = (rows: ReturnType<typeof build>['rows']) => rows.flatMap((row) => row.kind === 'header' ? [row.label] : [])

describe('how a query finds a record', () => {
  const search = (query: string) => new SearchQuery(query)

  test('the words in its title are a name hit; words only in its other text are evidence with the passage', () => {
    // WHY: a name is what a person remembers and types, so it ranks above
    // text that only mentions the words. The passage is the row's proof.
    const record = work('w1', 'Release checklist', { snippet: 'Steps for the staging rollout and the smoke test.' })
    expect(matchRecord(record, search('release'), NOW)).toMatchObject({ relevance: { tier: 'name' } })
    const evidence = matchRecord(record, search('staging rollout'), NOW)
    expect(evidence).toMatchObject({ relevance: { tier: 'evidence' } })
    expect(evidence?.passage).toContain('staging rollout')
    expect(matchRecord(record, search('billing'), NOW)).toBeNull()
  })

  test('an automation is found by its instructions, and a project by its folder', () => {
    expect(matchRecord({ type: 'automation', automation: automation('a1', 'Nightly triage', 'Label every new issue by area') }, search('label issue'), NOW))
      .toMatchObject({ relevance: { tier: 'evidence' } })
    expect(matchRecord(project('p1', 'solus', '/Users/me/code/solus-main'), search('code'), NOW)).toMatchObject({ relevance: { tier: 'evidence' } })
  })

  test('a pull request number, typed whole, is that pull request', () => {
    // WHY: "#42" names pull request 42 itself. Pull request 420 only starts with it.
    expect(matchRecord(pullRequest(42, 'Fix login'), search('#42'), NOW)).toMatchObject({ relevance: { tier: 'id' } })
    expect(matchRecord(pullRequest(420, 'Fix login'), search('42'), NOW)).toBeNull()
  })

  test('a pull request the code host found is kept though this client does not hold the words', () => {
    // WHY: the code host searches the description and the comments. Dropping
    // its answer because the title lacks the words would hide the hit.
    expect(matchRecord(pullRequest(7, 'Refactor routing', { hostMatched: true }), search('websocket'), NOW)).toMatchObject({ relevance: { tier: 'evidence' } })
    expect(matchRecord(pullRequest(7, 'Refactor routing'), search('websocket'), NOW)).toBeNull()
    expect(matchRecord(pullRequest(7, 'Refactor routing', { headRef: 'fix/websocket-retry' }), search('websocket'), NOW)?.passage).toContain('websocket')
  })
})

describe('the height of a record row', () => {
  test('a pull request has the height of its row on the pull requests page', () => {
    // WHY: the search draws a pull request with that page's row. The
    // virtualiser places rows from this height before they paint, so a wrong
    // height puts every row after it in the wrong place.
    const { rows } = build({ records: [pullRequest(9, 'Bump wrangler'), work('w1', 'Notes')], query: 'bump', resultType: 'pullRequests' })
    const row = rows.find((candidate) => candidate.kind === 'record')!
    expect(pickerRowHeight(row)).toBe(PR_LIST_ROW_HEIGHT)
    const workRow = build({ records: [work('w1', 'Notes')], resultType: 'works' }).rows.find((candidate) => candidate.kind === 'record')!
    expect(pickerRowHeight(workRow)).toBe(44)
  })
})

describe('the second line of a record row', () => {
  test('says a pull request is merged or closed, and says nothing more of an open one', () => {
    // WHY: a query asks the code host for every state, so the row must tell
    // an open pull request from one that is done.
    expect(recordDetail(pullRequest(3, 'Fix release script', { state: 'merged' }))).toBe('#3 · Merged · solus · mona')
    expect(recordDetail(pullRequest(3, 'Fix release script'))).toBe('#3 · solus · mona')
  })
})

describe('the preview of a work', () => {
  test('does not repeat the title when the document opens with it as a heading', () => {
    // WHY: the preview shows the title above the body. A document that opens
    // with the same heading showed the title two times.
    expect(workPreviewBody('Rollout notes', '# Rollout notes\n\nOwner: API Platform')).toBe('Owner: API Platform')
    // Another first heading is content, and it stays.
    expect(workPreviewBody('Rollout notes', '# Decision summary\n\nLimit by key.')).toBe('# Decision summary\n\nLimit by key.')
  })
})

describe('Recents', () => {
  test('lists the newest sessions and works together, then the actions', () => {
    // WHY: Recents is what the reader last worked on, whatever its type.
    const { rows, entries } = build({
      recentSessions: [recent('s-old', 5), recent('s-new', 1)],
      records: [work('w-mid', 'Design notes', { ageDays: 3 })],
      actions: [{ id: 'new-session', label: 'New session', run: () => {} }],
    })
    expect(headers(rows)).toEqual(['Recents', 'Actions'])
    expect(entries.map(titleOf)).toEqual(['session:s-new', 'work:w-mid', 'session:s-old', 'action:new-session'])
  })

  test('holds no task, pull request, automation or project', () => {
    // WHY: other people change these records, so their dates do not say what
    // the reader did. A list by those dates filled with work that is not theirs.
    const { entries } = build({
      tasks: [task('t1', 'Provider issue')],
      records: [pullRequest(1, 'Someone else'), { type: 'automation', automation: automation('a1', 'Nightly') }, project('p1', 'solus'), work('w1', 'Mine')],
    })
    expect(entries.map(titleOf)).toEqual(['work:w1'])
  })

  test('is a short list: the types hold the rest', () => {
    const many = Array.from({ length: RECENTS_SHOWN + 5 }, (_, index) => recent(`s${index}`, index))
    const recents = build({ recentSessions: many })
    expect(recents.entries).toHaveLength(RECENTS_SHOWN)
    expect(recents.entries.map(titleOf)[0]).toBe('session:s0')
    // The Sessions type lists every session.
    expect(build({ recentSessions: many, resultType: 'sessions' }).entries).toHaveLength(RECENTS_SHOWN + 5)
  })
})

describe('a list of one type', () => {
  const records = [
    work('w-old', 'Roadmap', { ageDays: 9 }), work('w-new', 'Release notes', { ageDays: 1 }),
    pullRequest(3, 'Fix release script'), { type: 'automation', automation: automation('a1', 'Release watch') } satisfies PickerRecord,
    project('p-b', 'beta'), project('p-a', 'alpha'),
  ]

  test('lists only that type, newest first, and no action', () => {
    const { rows, entries, recordCount } = build({ records, resultType: 'works', actions: [{ id: 'new-session', label: 'New session', run: () => {} }] })
    expect(headers(rows)).toEqual(['Works'])
    expect(entries.map(titleOf)).toEqual(['work:w-new', 'work:w-old'])
    expect(recordCount).toBe(2)
  })

  test('keeps the query when the type changes: the same words, another kind', () => {
    const forType = (resultType: PickerResultType) => build({ records, resultType, query: 'release' }).entries.map(titleOf)
    expect(forType('works')).toEqual(['work:w-new'])
    expect(forType('pullRequests')).toEqual(['pr:local:/repo:3'])
    expect(forType('automations')).toEqual(['automation:a1'])
    expect(forType('projects')).toEqual([])
  })

  test('says that the pull requests of an empty box are the open ones', () => {
    // WHY: an empty box reads the open list. A query asks the code host for every state.
    expect(headers(build({ records, resultType: 'pullRequests' }).rows)).toEqual(['Open pull requests'])
    expect(headers(build({ records, resultType: 'pullRequests', query: 'release' }).rows)).toEqual(['Pull requests'])
  })

  test('projects keep the order of every project list', () => {
    expect(build({ records, resultType: 'projects' }).entries.map(titleOf)).toEqual(['project:p-b', 'project:p-a'])
  })

  test('Updated narrows the records that have a date, and no project', () => {
    const filters = { ...NO_PICKER_FILTERS, updated: 'week' as const }
    expect(build({ records, resultType: 'works', filters }).entries.map(titleOf)).toEqual(['work:w-new'])
    expect(build({ records, resultType: 'projects', filters }).entries).toHaveLength(2)
  })
})

describe('a query across every type', () => {
  test('lists each kind in its own section, in a fixed order', () => {
    // Newest first lists the sections as they are: no row is lifted into Top hits.
    const { rows } = build({
      query: 'release',
      sort: 'recency',
      tasks: [task('t1', 'Release blockers')],
      sessionsFor: () => [child('s1', 'Release dry run')],
      records: [project('p1', 'release-tools'), { type: 'automation', automation: automation('a1', 'Release watch') }, pullRequest(3, 'Fix release script'), work('w1', 'Release notes')],
      actions: [{ id: 'new-session', label: 'New session', run: () => {} }],
    })
    expect(headers(rows)).toEqual(['Tasks', 'Sessions', 'Works', 'Pull requests', 'Automations', 'Projects'])
  })

  test('a record named for the query is lifted above the tasks and sessions that only hold the words', () => {
    // WHY: the sections have a fixed order, so the work the reader named sat
    // under every task and session that matched at all.
    const noise = Array.from({ length: 6 }, (_, index) => task(`t${index}`, `Fix onboarding copy after review ${index}`))
    const { rows, entries } = build({ query: 'onboarding', tasks: noise, records: [work('w1', 'Onboarding', { ageDays: 30 })] })
    expect(rows[0]).toMatchObject({ kind: 'header', label: 'Top hits' })
    expect(titleOf(entries[0]!)).toBe('work:w1')
    // Listed once: a lifted row leaves its section.
    expect(entries.filter((entry) => titleOf(entry) === 'work:w1')).toHaveLength(1)
    expect(headers(rows)).not.toContain('Works')
  })

  test('an action is listed only when the query names it', () => {
    const actions = [{ id: 'new-session', label: 'New session', run: () => {} }]
    expect(build({ query: 'new sess', actions }).entries.map(titleOf)).toEqual(['action:new-session'])
    expect(build({ query: 'release', actions }).entries).toEqual([])
  })

  test('the Sessions and Tasks types list no record', () => {
    const records = [work('w1', 'Release notes')]
    expect(build({ query: 'release', records, resultType: 'sessions' }).entries).toEqual([])
    expect(build({ query: 'release', records, resultType: 'tasks' }).entries).toEqual([])
  })
})

describe('the project scope of automations', () => {
  test('keeps the automations of the scoped project, and every automation with no scope', () => {
    const automations = [automation('a1', 'In solus'), automation('a2', 'In site')]
    const projectKeyOf = (item: Automation) => item.id === 'a1' ? 'solus' : 'site'
    expect(automationRecords(automations, projectKeyOf, 'solus').map(recordKey)).toEqual(['automation:a1'])
    expect(automationRecords(automations, projectKeyOf, null)).toHaveLength(2)
  })
})

describe('the type tabs', () => {
  test('the arrows step through the types, and the ends join', () => {
    // WHY: one key reaches the last tab from the first.
    expect(adjacentResultType(PICKER_RESULT_TYPES, 'all', 1)).toBe('sessions')
    expect(adjacentResultType(PICKER_RESULT_TYPES, 'all', -1)).toBe('projects')
    expect(adjacentResultType(PICKER_RESULT_TYPES, 'projects', 1)).toBe('all')
    // A type the list does not offer (a guest's list) starts again at the first.
    expect(adjacentResultType(['all', 'sessions'], 'works', 1)).toBe('sessions')
  })
})

describe('the count under the list', () => {
  test('Recents has no count; a query counts every kind of result', () => {
    // WHY: Recents is a selection. A count there would read as "all there is".
    const recents = build({ recentSessions: [recent('s1', 1)] })
    expect(pickerCountLabel(recents, 'all', false)).toBe('')
    const queried = build({ query: 'release', tasks: [task('t1', 'Release blockers')], records: [work('w1', 'Release notes')] })
    expect(pickerCountLabel(queried, 'all', true)).toBe('2 results')
    expect(pickerCountLabel(build({ records: [pullRequest(1, 'One')], resultType: 'pullRequests' }), 'pullRequests', false)).toBe('1 pull request')
  })
})

describe('an empty list says why it is empty', () => {
  const state = (overrides: Partial<PickerEmptyState>): PickerEmptyState => ({
    type: 'all', query: '', scopeLabel: null, tasksLoading: false,
    everySession: { loading: false, error: null, asked: 1, passedOver: 0 },
    sessionSearch: { loading: false, hasErrors: false, indexing: false },
    worksLoading: false, automationsLoading: false,
    pullRequests: { loading: false, error: null, projectCount: 1 },
    ...overrides,
  })

  test('a host that did not answer is not "no pull requests"', () => {
    // WHY: an empty list must not claim there is nothing when a host failed.
    expect(pickerEmptyMessage(state({ type: 'pullRequests', pullRequests: { loading: false, error: 'GitHub is not connected', projectCount: 1 } })))
      .toBe('Could not read pull requests: GitHub is not connected')
    expect(pickerEmptyMessage(state({ type: 'pullRequests', scopeLabel: 'solus' }))).toBe('No open pull requests in solus')
  })

  test('the scope is named, because it is the likely reason', () => {
    expect(pickerEmptyMessage(state({ type: 'works', query: 'roadmap', scopeLabel: 'solus' }))).toBe('No works match “roadmap” in solus')
    // Projects are not narrowed by the scope.
    expect(pickerEmptyMessage(state({ type: 'projects', query: 'zzz', scopeLabel: 'solus' }))).toBe('No projects match “zzz”')
  })

  test('placeholder rows show while a read of the type in view can still fill the list', () => {
    // WHY: "No pull requests" before the code host answers is a false
    // statement. A read of another type is not a reason to wait.
    const reading = { loading: true, error: null, asked: null, passedOver: 0 }
    expect(pickerListLoading(state({ type: 'pullRequests', pullRequests: { loading: true, error: null, projectCount: 1 } }))).toBe(true)
    expect(pickerListLoading(state({ type: 'all', everySession: reading }))).toBe(true)
    expect(pickerListLoading(state({ type: 'sessions', query: 'retry', sessionSearch: { loading: true, hasErrors: false, indexing: false } }))).toBe(true)
    // The Tasks type lists no session, so it does not wait for the sessions.
    expect(pickerListLoading(state({ type: 'tasks', everySession: reading }))).toBe(false)
    expect(pickerEmptyMessage(state({ type: 'tasks', everySession: reading }))).toBe('No tasks yet')
    // Recents holds no task and no pull request, so it does not wait for them.
    expect(pickerListLoading(state({ type: 'all', tasksLoading: true, pullRequests: { loading: true, error: null, projectCount: 1 } }))).toBe(false)
    // A query across every type can find a task or a pull request.
    expect(pickerListLoading(state({ type: 'all', query: 'retry', tasksLoading: true }))).toBe(true)
    expect(pickerListLoading(state({ type: 'all', query: 'retry', pullRequests: { loading: true, error: null, projectCount: 1 } }))).toBe(true)
    expect(pickerListLoading(state({ type: 'projects', worksLoading: true }))).toBe(false)
  })
})

describe('the action bar of a preview', () => {
  test('is only for a row with more than one thing to do', () => {
    // WHY: a bar that holds one button says only what ⏎ already does. A task
    // has a status to set, and a pull request opens here or in the browser.
    const { entries } = build({
      query: 'release', sort: 'recency',
      tasks: [task('t1', 'Release blockers')],
      recentSessions: [recent('s1', 1, 'Release dry run')],
      records: [work('w1', 'Release notes'), pullRequest(3, 'Fix release script'), project('p1', 'release-tools')],
    })
    const bars = Object.fromEntries(entries.map((entry) => [titleOf(entry), hasActionBar(entry)]))
    expect(bars).toEqual({ 'task:t1': true, 'session:s1': false, 'work:w1': false, 'pr:local:/repo:3': true, 'project:p1': false })
    expect(hasActionBar(null)).toBe(false)
    // A row with no bar says what ⏎ does in the key hints.
    expect(Object.fromEntries(entries.map((entry) => [titleOf(entry), entryOpenLabel(entry)])))
      .toEqual({ 'task:t1': 'Open task', 'session:s1': 'Resume', 'work:w1': 'Open', 'pr:local:/repo:3': 'Open', 'project:p1': 'New session' })
  })
})

describe('the menu of a row', () => {
  test('a task and a session have one; a record does not', () => {
    // WHY: the Actions key is offered only where it does something.
    const { entries } = build({ query: 'release', tasks: [task('t1', 'Release blockers')], records: [work('w1', 'Release notes')] })
    const [taskEntry, recordEntry] = entries
    expect(hasRowMenu(taskEntry!)).toBe(true)
    expect(rowMenuFor(taskEntry!, 10, 20)).toMatchObject({ kind: 'task', task: { id: 't1' }, x: 10, y: 20 })
    expect(hasRowMenu(recordEntry!)).toBe(false)
    expect(rowMenuFor(recordEntry!, 10, 20)).toBeNull()
    expect(hasRowMenu(null)).toBe(false)
  })
})
