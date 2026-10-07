import { describe, expect, test } from 'bun:test'
import { plainSnippet, SNIPPET_HIT_CLOSE, SNIPPET_HIT_OPEN } from '@solus/contracts/search-snippet'
import type { Task } from '@solus/contracts/task-types'
import type { SessionMeta, SessionSearchResult } from '@solus/contracts/types'
import type { PickerSort } from '@solus/workspace-ui/components/session/unified-picker/lib/picker-search'
import type { SidebarSessionChild } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'
import { NO_PICKER_FILTERS } from '@solus/workspace-ui/components/session/unified-picker/lib/picker-filters'
import {
  buildPickerRows,
  collapseTarget,
  expandTarget,
  isTaskGroup,
  pickerRowHeight,
  previewHitTarget,
  selectedRowIndex,
} from '@solus/workspace-ui/components/session/unified-picker/lib/picker-rows'

function task(id: string, title: string, body = ''): Task {
  return {
    id,
    title,
    body,
    status: 'in_progress',
    priority: null,
    projectKey: 'solus',
    providerId: 'local',
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Task
}

function child(sessionId: string, label: string): SidebarSessionChild {
  return {
    sessionId,
    label,
    branchName: null,
    attention: null,
    unread: false,
    serverId: 'local',
    runStartedAt: 0,
    lastActivityAt: 0,
    reviewGuideStatus: null,
  }
}

function build(
  tasks: Task[],
  sessions: Record<string, SidebarSessionChild[]>,
  query = '',
  expanded: string[] = [],
  openTaskIds: string[] = [],
) {
  return buildPickerRows({
    tasks,
    query,
    sessionsFor: (item) => sessions[item.id] ?? [],
    expandedTaskIds: new Set(expanded),
    openTaskIds: new Set(openTaskIds),
  })
}

describe('unified picker rows', () => {
  const tasks = [task('a', 'Alpha'), task('b', 'Beta')]
  const sessions = {
    a: [child('a1', 'first pass'), child('a2', 'second pass')],
    b: [child('b1', 'beta run')],
  }

  test('a task with one session is still a group', () => {
    // WHY: the preview column reads a task row and its session row
    // differently, so a group of one keeps its disclosure.
    const { entries } = build(tasks, sessions)
    const alpha = entries[0]
    const beta = entries[1]
    if (alpha.kind !== 'task' || beta.kind !== 'task') throw new Error('expected task rows')
    expect(isTaskGroup(alpha)).toBe(true)
    expect(isTaskGroup(beta)).toBe(true)
  })

  test('tasks and their expanded sessions form one keyboard sequence', () => {
    const { rows, entries } = build(tasks, sessions, '', ['a'])
    expect(rows.map((row) => row.kind)).toEqual(['header', 'task', 'session', 'session', 'task'])
    expect(entries.map((entry) => entry.entryIndex)).toEqual([0, 1, 2, 3])
    // Headers take no index, so ↓ from the last session lands on the next task.
    expect(entries[3]).toMatchObject({ kind: 'task', task: { id: 'b' } })
  })

  test('a collapsed task hides its sessions from the keyboard, not just from view', () => {
    const { entries } = build(tasks, sessions)
    expect(entries.map((entry) => entry.kind)).toEqual(['task', 'task'])
  })

  test('open in-progress sidebar tasks are lifted into the top section without duplicates', () => {
    const todo = { ...task('c', 'Gamma'), status: 'todo' as const }
    const { rows } = buildPickerRows({
      tasks: [...tasks, todo],
      query: '',
      resultType: 'tasks',
      sessionsFor: (item) => sessions[item.id as keyof typeof sessions] ?? [],
      expandedTaskIds: new Set(),
      openTaskIds: new Set(['a', 'c']),
    })
    expect(rows.filter((row) => row.kind === 'header').map((row) => row.label)).toEqual([
      'Open',
      'In progress',
      'Todo',
    ])
    expect(rows.filter((row) => row.kind === 'task').map((row) => row.task.id)).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  test('selection alone does not open a task group', () => {
    // WHY: pointer hover and arrow navigation both select rows. Disclosure is
    // reserved for an explicit click, Space, or ArrowRight action.
    expect(build(tasks, sessions).rows.map((row) => row.kind)).toEqual([
      'header',
      'task',
      'task',
    ])
  })

  test('a session the query names is listed flat under Sessions, not under its task', () => {
    // WHY: the reader searched for the session, so the session is the row. Its
    // task is its byline. The task is not a hit and is not listed as one.
    const sessionsWithSibling = {
      ...sessions,
      b: [...sessions.b, child('b2', 'unrelated follow-up')],
    }
    const { rows, entries, sessionCount } = build(tasks, sessionsWithSibling, 'beta run')
    expect(rows.map((row) => row.kind)).toEqual(['header', 'session'])
    expect(rows[0]).toMatchObject({ label: 'Sessions', count: 1, hint: 'best match first' })
    expect(rows[1]).toMatchObject({ session: { sessionId: 'b1' }, task: { id: 'b' }, nested: false })
    expect(sessionCount).toBe(1)
    // A flat session has no parent row to return to.
    expect(collapseTarget(entries, 0)).toBeNull()
  })

  test('sessions the query names are ordered newest first among themselves', () => {
    // Name hits tie on relevance, so the date breaks the tie under either order.
    const dated = {
      a: [{ ...child('a1', 'first pass'), lastActivityAt: 10 }, { ...child('a2', 'second pass'), lastActivityAt: 30 }],
      b: [{ ...child('b1', 'beta pass'), lastActivityAt: 20 }],
    }
    const { entries } = build(tasks, dated, 'pass')
    expect(entries.map((entry) => entry.kind === 'session' && entry.session.sessionId)).toEqual([
      'a2', 'b1', 'a1',
    ])
  })

  test('a task title match stays a task result without nested search duplicates', () => {
    // WHY: the task row is the evidence. Opening every title match filled the
    // list with sessions and pushed the other sections below the fold.
    const { rows } = build(tasks, sessions, 'alpha')
    expect(rows.map((row) => row.kind)).toEqual(['header', 'task'])
    expect(rows[0]).toMatchObject({ label: 'Tasks', count: 1, hint: 'best match first' })
    expect(rows[1]).toMatchObject({
      kind: 'task',
      expanded: false,
      matchedIn: 'title',
      sessions: [{ sessionId: 'a1' }, { sessionId: 'a2' }],
    })
    const opened = build(tasks, sessions, 'alpha', ['a'])
    expect(opened.rows.map((row) => row.kind)).toEqual(['header', 'task'])
  })

  test('tasks rank by where they matched: title, then body, then id', () => {
    // WHY: "best match first" is the header's promise. Newest-first within a
    // tier is the tiebreak, so the input order (newest first) is kept. A status
    // or a project path is not a field: matching it listed every task that
    // shared it, which is noise, not a hit.
    const ranked = [
      { ...task('body-new', 'Rollout'), body: 'needs the auth token' },
      task('title-old', 'Auth flow'),
      { ...task('status-hit', 'Unrelated'), status: 'in_progress' as const },
      { ...task('body-old', 'Login'), body: 'auth again' },
    ]
    const { rows } = build(ranked, {}, 'auth')
    const taskRows = rows.filter((row) => row.kind === 'task')
    expect(taskRows.map((row) => row.task.id)).toEqual(['title-old', 'body-new', 'body-old'])
    expect(taskRows.map((row) => row.matchedIn)).toEqual(['title', 'body', 'body'])
    expect(build(ranked, {}, 'in_progress').entries).toEqual([])
    expect(build(ranked, {}, 'solus').entries).toEqual([])
  })

  test('under the recency order tasks keep their date order whatever field matched', () => {
    // WHY: the reader asked for newest first, and the header says so. Lifting
    // a stale title hit over a fresh body hit would contradict the header.
    const dated = [
      { ...task('body-new', 'Rollout'), body: 'needs the auth token', updatedAt: 30 },
      { ...task('title-old', 'Auth flow'), updatedAt: 10 },
    ]
    const relevance = buildPickerRows({ tasks: dated, query: 'auth', sessionsFor: () => [], expandedTaskIds: new Set() })
    const recency = buildPickerRows({ tasks: dated, query: 'auth', sort: 'recency', sessionsFor: () => [], expandedTaskIds: new Set() })
    expect(relevance.entries.map((entry) => entry.kind === 'task' && entry.task.id)).toEqual(['title-old', 'body-new'])
    expect(recency.entries.map((entry) => entry.kind === 'task' && entry.task.id)).toEqual(['body-new', 'title-old'])
    expect(relevance.rows[0]).toMatchObject({ kind: 'header', hint: 'best match first' })
    expect(recency.rows[0]).toMatchObject({ kind: 'header', hint: 'newest first' })
  })

  test('a query is words, each starting a token, in any order — the rule the index applies', () => {
    // WHY: the hosts match "auth flow" to a message that says "the flow for
    // auth". A title pass that needed the phrase in order found half of what
    // the Sessions section found for the same query, and "auth" marked the
    // tail of "oauth" in one section and not the other.
    const titled = [task('a', 'Flow for auth'), task('b', 'OAuth redesign'), task('c', 'Authentication')]
    expect(build(titled, {}, 'auth flow').entries.map((entry) => entry.kind === 'task' && entry.task.id)).toEqual(['a'])
    expect(build(titled, {}, 'auth').entries.map((entry) => entry.kind === 'task' && entry.task.id).toSorted()).toEqual(['a', 'c'])
    // A session name follows the same rule.
    const named = { a: [child('a1', 'Retry the oauth dance'), child('a2', 'Auth retry')] }
    expect(build([task('a', 'Alpha')], named, 'retry auth').entries.map((entry) => entry.kind === 'session' && entry.session.sessionId)).toEqual(['a2'])
  })

  test('a task found by its id says so with the id, not a note', () => {
    const numbered = { ...task('t', 'Rollout'), shortId: 42 } as Task
    const [row] = build([numbered], {}, 'T-42').rows.filter((row) => row.kind === 'task')
    expect(row.matchedIn).toBe('id')
    expect(build([numbered], {}, '42').taskCount).toBe(1)
    // The uuid is not an id anyone types.
    expect(build([{ ...numbered, id: 'uuid-9f' } as Task], {}, '9f').taskCount).toBe(0)
  })

  test('a body hit shows the passage it hit as the row\'s second line', () => {
    const long = `${'lead-in words '.repeat(10)}the AUTH token expired${' trailing words'.repeat(10)}`
    const { rows } = build([{ ...task('t', 'Rollout'), body: long }], {}, 'auth token')
    const [row] = rows.filter((row) => row.kind === 'task')
    // Cut on both sides, hit kept whole with its case, whitespace collapsed.
    expect(row.bodySnippet).toMatch(/^…(lead-in words )+the AUTH token expired( trailing words)+.*…$/)
    expect(row.bodySnippet!.length).toBeLessThan(120)
    // A title hit needs no passage; the title is already marked.
    const [titleRow] = build([task('u', 'Auth flow')], {}, 'auth').rows.filter((r) => r.kind === 'task')
    expect(titleRow.bodySnippet).toBeUndefined()
  })

  test('without a query every lifecycle section states its order', () => {
    const { rows } = build(tasks, sessions)
    expect(rows.filter((row) => row.kind === 'header').map((row) => row.hint)).toEqual(['newest first'])
  })

  test('a task matching nothing is dropped', () => {
    const { entries } = build(tasks, sessions, 'nothing here')
    expect(entries).toEqual([])
  })

  describe('conversation hits', () => {
    function hit(sessionId: string, snippet: string, ts = 0, serverId = 'local', rank = -1): SessionSearchResult {
      return {
        session: { sessionId, serverId, firstMessage: `opening of ${sessionId}` } as SessionMeta,
        snippet,
        ts,
        messageId: 7,
        rank,
      }
    }
    function buildWithHits(
      query: string,
      hits: SessionSearchResult[],
      expanded: string[] = [],
      projectKey: string | null = null,
      sort: PickerSort = 'relevance',
      remaining = 0,
      sessionsOnly = false,
    ) {
      return buildPickerRows({
        tasks,
        query,
        projectKey,
        sort,
        sessionsFor: (item) => sessions[item.id] ?? [],
        expandedTaskIds: new Set(expanded),
        conversations: hits,
        conversationsRemaining: remaining,
        resultType: sessionsOnly ? 'sessions' : 'all',
      })
    }

    test('sessions only keeps passage hits when their parent task matches', () => {
      const result = buildWithHits('Alpha', [hit('a1', 'Alpha passage')], [], null, 'relevance', 0, true)
      expect(result.taskCount).toBe(0)
      expect(result.entries).toHaveLength(1)
      expect(result.entries[0]).toMatchObject({ kind: 'session', session: { sessionId: 'a1' }, hit: { messageId: 7 } })
    })

    test('under relevance, name hits lead and content hits follow the index score', () => {
      // WHY: a session's name is its title, the strongest claim a query has
      // on it; among passages the index already knows which is the better
      // match, and throwing that away for the date made the section a timeline
      // whatever the header promised.
      const dated = {
        a: [{ ...child('a1', 'pass by name'), lastActivityAt: 1 }],
        b: [],
      }
      const listed = (sort: PickerSort) => buildPickerRows({
        tasks,
        query: 'pass',
        sort,
        sessionsFor: (item) => dated[item.id as 'a' | 'b'] ?? [],
        expandedTaskIds: new Set(),
        conversations: [
          hit('weak-new', 'pass here', 900, 'local', -1),
          hit('strong-old', 'pass pass pass', 100, 'local', -9),
        ],
      }).entries.map((entry) => entry.kind === 'session' ? entry.session.sessionId : entry.kind === 'conversation' ? entry.meta.sessionId : null)
      expect(listed('relevance')).toEqual(['a1', 'strong-old', 'weak-new'])
      expect(listed('recency')).toEqual(['weak-new', 'strong-old', 'a1'])
    })

    test('a session whose name and words both matched ranks as a name hit and shows its words', () => {
      const named = { a: [child('a1', 'pass one')], b: [] }
      const { entries } = buildPickerRows({
        tasks,
        query: 'pass',
        sessionsFor: (item) => named[item.id as 'a' | 'b'] ?? [],
        expandedTaskIds: new Set(),
        conversations: [hit('orphan', 'a pass', 5, 'local', -20), hit('a1', 'pass said', 1, 'local', -1)],
      })
      expect(entries.map((entry) => entry.kind === 'session' ? entry.session.sessionId : entry.meta.sessionId)).toEqual(['a1', 'orphan'])
      expect(entries[0]).toMatchObject({ kind: 'session', hit: { snippet: 'pass said' } })
    })

    test('a passage is cut around its first marked hit and keeps the marks', () => {
      // WHY: the index returns a window of tokens the hit can sit anywhere in,
      // and the row shows one line of it. Cut from the start, a hit in the back
      // half fell off the line and the row showed no evidence at all.
      const marked = `${'lead words '.repeat(12)}the ${SNIPPET_HIT_OPEN}pelican${SNIPPET_HIT_CLOSE} lands${' and more'.repeat(20)}`
      const { entries } = buildWithHits('pelican', [hit('orphan', marked)])
      const snippet = entries[0].kind === 'conversation' ? entries[0].hit.snippet : ''
      expect(plainSnippet(snippet)).toMatch(/^…[^…]*the pelican lands[^…]*…$/)
      expect(snippet).toContain(`${SNIPPET_HIT_OPEN}pelican${SNIPPET_HIT_CLOSE}`)
      expect(snippet.indexOf(SNIPPET_HIT_OPEN)).toBeLessThan(40)
    })

    test('the Sessions header counts every match the hosts hold, and the list ends with a row that reads the rest', () => {
      // WHY: every session that matches is reachable (unified-search.md §6).
      // The count is the whole answer, not a cap, and the end row is what the
      // list reads the next page with; the keyboard never lands on it.
      const paged = buildWithHits('alpha', [hit('orphan', 'alpha')], [], null, 'relevance', 40)
      expect(paged.rows.find((row) => row.kind === 'header' && row.label === 'Sessions')).toMatchObject({ count: 41 })
      expect(paged.rows.at(-1)).toMatchObject({ kind: 'more', remaining: 40 })
      expect(paged.entries.some((entry) => (entry.kind as string) === 'more')).toBe(false)
      expect(paged.sessionCount).toBe(41)
      const whole = buildWithHits('alpha', [hit('orphan', 'alpha')])
      expect(whole.rows.find((row) => row.kind === 'header' && row.label === 'Sessions')).toMatchObject({ count: 1 })
      expect(whole.rows.some((row) => row.kind === 'more')).toBe(false)
    })

    test('a session no task claims, found by its words, is listed under Sessions', () => {
      // WHY: the reader searched for what was said, not for a title, so a
      // session no task claims must still be reachable — in the one section
      // every session hit shares, not a section of its own.
      const { rows, entries, sessionCount } = buildWithHits('alpha', [
        hit('orphan', '…the alpha rollout…'),
      ])
      expect(rows.map((row) => row.kind)).toEqual(['header', 'task', 'header', 'conversation'])
      expect(rows[2]).toMatchObject({ kind: 'header', label: 'Sessions', count: 1, hint: 'best match first' })
      expect(entries.at(-1)).toMatchObject({
        kind: 'conversation',
        entryIndex: 1,
        hit: { snippet: '…the alpha rollout…', messageId: 7 },
      })
      expect(sessionCount).toBe(1)
    })

    test("a hit in a task's session is that session's row, carrying the passage", () => {
      // WHY: the same session must not appear once by name and once by words.
      // The words are the better evidence, so the row keeps them and its date
      // is when they were said; the task rides along as the byline.
      const { rows } = buildWithHits('said', [hit('b1', 'it was said here', 500)])
      const listed = rows.filter((row) => row.kind !== 'header')
      expect(listed).toHaveLength(1)
      expect(listed[0]).toMatchObject({
        kind: 'session',
        session: { sessionId: 'b1' },
        task: { id: 'b' },
        nested: false,
        hit: { snippet: 'it was said here', ts: 500, messageId: 7 },
      })
    })

    test('a matching task does not hide matching sessions or duplicate them when expanded', () => {
      const hits = [hit('a1', 'alpha again'), hit('b1', 'alpha in beta')]
      const { rows } = buildWithHits('alpha', hits)
      expect(rows.map((row) => row.kind)).toEqual(['header', 'task', 'header', 'session', 'session'])
      const opened = buildWithHits('alpha', hits, ['a'])
      expect(opened.entries.map((entry) => entry.key)).toEqual(rows.filter((row) => row.kind !== 'header').map((row) => row.key))
    })

    test('under recency, name hits and word hits share one order: newest first by the date each row shows', () => {
      const dated = {
        a: [{ ...child('a1', 'first pass'), lastActivityAt: 300 }],
        b: [{ ...child('b1', 'beta run'), lastActivityAt: 100 }],
      }
      const { entries } = buildPickerRows({
        tasks,
        query: 'pass',
        sort: 'recency',
        sessionsFor: (item) => dated[item.id as 'a' | 'b'] ?? [],
        expandedTaskIds: new Set(),
        conversations: [hit('orphan', 'a pass elsewhere', 200), hit('b1', 'pass in beta', 400)],
      })
      expect(entries.map((entry) => entry.kind === 'session' ? entry.session.sessionId : entry.meta.sessionId))
        .toEqual(['a1', 'orphan', 'b1'])
    })

    test("a hit in a session of a task the scope removed stays out, whatever the host said", () => {
      // WHY: the scope promised only this project's work; a session row for
      // a task the scope hid would contradict the hidden count beside it.
      const { rows, hiddenTaskCount } = buildWithHits('beta', [hit('b1', 'beta said')], [], 'elsewhere')
      expect(rows).toEqual([])
      expect(hiddenTaskCount).toBe(1)
    })

    test('a stale hit list is ignored once the query is cleared', () => {
      const { rows, sessionCount } = buildWithHits('', [hit('orphan', 'left over')])
      expect(rows.some((row) => row.kind === 'conversation')).toBe(false)
      expect(sessionCount).toBe(3)
    })

    test('a conversation row has no parent to collapse into', () => {
      const { entries } = buildWithHits('alpha', [hit('orphan', 'alpha')])
      expect(collapseTarget(entries, entries.length - 1)).toBeNull()
      expect(expandTarget(entries.at(-1))).toBeNull()
    })

    test('the preview opens on the hit only for rows found by their words, on a known host', () => {
      const { entries } = buildWithHits('said', [hit('orphan', 'said', 1), hit('b1', 'said', 5)])
      expect(entries.map((entry) => previewHitTarget(entry))).toEqual([
        { serverId: 'local', sessionId: 'orphan', messageId: 7 },
        { serverId: 'local', sessionId: 'b1', messageId: 7 },
      ])
      // A name hit has no passage to open on, and a hit with no host has nowhere to ask.
      const [byName] = build(tasks, sessions, 'first pass').entries
      expect(previewHitTarget(byName)).toBeNull()
      const unstamped = buildWithHits('alpha', [hit('orphan', 'alpha', 0, '')]).entries.at(-1)!
      expect(previewHitTarget(unstamped)).toBeNull()
    })
  })

  test('→ opens a collapsed task, then steps into it', () => {
    const collapsed = build(tasks, sessions).entries[0]
    expect(expandTarget(collapsed)).toEqual({ action: 'expand', taskId: 'a' })
    const opened = build(tasks, sessions, '', ['a']).entries[0]
    expect(expandTarget(opened)).toEqual({ action: 'step' })
  })

  test('→ does nothing on a task with no sessions', () => {
    const { entries } = build([task('c', 'Gamma')], {})
    expect(expandTarget(entries[0])).toBeNull()
  })

  test('← returns from a session to its task, then collapses it', () => {
    const { entries } = build(tasks, sessions, '', ['a'])
    expect(collapseTarget(entries, 2)).toEqual({ action: 'select', entryIndex: 0 })
    expect(collapseTarget(entries, 0)).toEqual({ action: 'collapse', taskId: 'a' })
    expect(collapseTarget(entries, 3)).toBeNull()
  })

  test('the total counts what is listed: every session unqueried, only named sessions under a query', () => {
    expect(build(tasks, sessions).sessionCount).toBe(3)
    expect(build(tasks, sessions, 'alpha').sessionCount).toBe(0)
    expect(build(tasks, sessions, 'pass').sessionCount).toBe(2)
  })

  test('the cursor maps to a row index past the headers', () => {
    const { rows } = build(tasks, sessions, '', ['a'])
    expect(selectedRowIndex(rows, 0)).toBe(1)
    expect(selectedRowIndex(rows, 3)).toBe(4)
    expect(selectedRowIndex([], 0)).toBe(-1)
  })

  // The virtualiser positions rows from this table before they paint, so a
  // row kind with no height would put every row after it in the wrong place.
  test('every row kind has a height', () => {
    const { rows } = build(tasks, sessions, '', ['a'])
    for (const row of rows) expect(pickerRowHeight(row)).toBeGreaterThan(0)
  })

  test('the last session under a task is taller by the nest padding', () => {
    const { rows } = build(tasks, sessions, '', ['a'])
    const [first, last] = rows.filter((row) => row.kind === 'session')
    expect(pickerRowHeight(last) - pickerRowHeight(first)).toBe(4)
  })
})

/**
 * The picker opens where the user already is. Opening it from a project's own
 * composer and getting every other project's work back is what this scope
 * exists to prevent, so these assert the scope decision itself — not the row
 * shapes above.
 */
describe('unified picker project scope', () => {
  function inProject(id: string, title: string, projectKey: string): Task {
    return { ...task(id, title), projectKey } as Task
  }

  const mixed = [
    inProject('a', 'Route models', 'model-routing'),
    inProject('b', 'Ship the site', 'solus'),
    inProject('c', 'Route more models', 'model-routing'),
  ]

  function scoped(projectKey: string | null, query = '', projectKeyOf?: (task: Task) => string | null) {
    return buildPickerRows({
      tasks: mixed,
      query,
      projectKey,
      projectKeyOf,
      sessionsFor: () => [],
      expandedTaskIds: new Set<string>(),
    })
  }

  test('a scope lists only that project and says how much it withheld', () => {
    const list = scoped('model-routing')
    expect(list.entries.map((entry) => entry.task.id)).toEqual(['a', 'c'])
    expect(list.hiddenTaskCount).toBe(1)
  })

  test('a scope lists the tasks of every checkout of its project', () => {
    // One row stands for the project, so choosing it must not keep only the
    // checkout its row happens to be named by.
    const list = scoped('github.com/acme/app', '', () => 'github.com/acme/app')
    expect(list.entries.map((entry) => entry.task.id)).toEqual(['a', 'b', 'c'])
    expect(list.hiddenTaskCount).toBe(0)
  })

  test('no scope lists every project and withholds nothing', () => {
    const list = scoped(null)
    expect(list.entries.map((entry) => entry.task.id)).toEqual(['a', 'b', 'c'])
    expect(list.hiddenTaskCount).toBe(0)
  })

  test('the withheld count reports query hits, not the whole catalog', () => {
    // The control offers to widen the search; it must promise only results the
    // widened search would actually produce.
    const list = scoped('model-routing', 'ship')
    expect(list.taskCount).toBe(0)
    expect(list.hiddenTaskCount).toBe(1)
  })
})


describe('sessions-only picker', () => {
  const tasks = [task('a', 'Auth task'), task('b', 'Other task')]
  const sessions = [child('a1', 'Auth session'), child('a2', 'Unrelated session')]

  test('a matching parent task cannot hide a matching session or add unrelated sessions', () => {
    const result = buildPickerRows({
      tasks, query: 'auth', resultType: 'sessions' as const,
      sessionsFor: (item) => item.id === 'a' ? sessions : [],
      expandedTaskIds: new Set(['a']),
    })
    expect(result.taskCount).toBe(0)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({ kind: 'session', nested: false, session: { sessionId: 'a1' } })
  })

  test('an empty query lists sessions directly and keeps project scope', () => {
    const input = {
      tasks, query: '', resultType: 'sessions' as const,
      sessionsFor: (item: Task) => item.id === 'a' ? sessions : [],
      expandedTaskIds: new Set<string>(),
    }
    const result = buildPickerRows(input)
    expect(result.entries.map((entry) => entry.kind)).toEqual(['session', 'session'])
    expect(result.taskCount).toBe(0)
    expect(buildPickerRows({ ...input, projectKey: 'another-project' }).entries).toEqual([])
    expect(buildPickerRows({ ...input, resultType: 'all' }).taskCount).toBe(2)
  })

  test('an empty query lists recent sessions no task claims beside the task sessions', () => {
    // WHY: a session has no task of its own (task-conversation.md §8). Listing
    // task sessions only, the Sessions result type hid most sessions.
    const result = buildPickerRows({
      tasks, query: '', resultType: 'sessions',
      sessionsFor: (item) => item.id === 'a' ? sessions : [],
      expandedTaskIds: new Set(),
      recentSessions: [recent('a1', 9_000), recent('loose', 5_000)],
    })
    expect(result.entries.map((entry) => entry.kind === 'conversation' ? entry.meta.sessionId : entry.kind === 'session' ? entry.session.sessionId : null))
      .toEqual(['loose', 'a1', 'a2'])
    expect(result.sessionCount).toBe(3)
  })
})

function recent(sessionId: string, at: number): SessionMeta {
  return { sessionId, serverId: 'local', firstMessage: `opening of ${sessionId}`, lastTimestamp: new Date(at).toISOString() } as SessionMeta
}

describe('the unqueried list', () => {
  test('tasks and the sessions no task claims are peers, newest first', () => {
    // WHY: tasks and sessions are equally things to return to. With no task
    // on the host, a picker that listed tasks only was empty however many
    // sessions it held.
    const older = { ...task('old', 'Old task'), updatedAt: 1_000 }
    const newer = { ...task('new', 'New task'), updatedAt: 6_000 }
    const result = buildPickerRows({
      tasks: [newer, older],
      query: '',
      sessionsFor: (item) => item.id === 'new' ? [child('claimed', 'Claimed session')] : [],
      expandedTaskIds: new Set(),
      recentSessions: [recent('claimed', 8_000), recent('fresh', 9_000), recent('middle', 3_000)],
    })
    expect(result.rows[0]).toMatchObject({ kind: 'header', label: 'Recent', count: 4 })
    expect(result.entries.map((entry) => entry.kind === 'task' ? entry.task.id : entry.kind === 'conversation' ? entry.meta.sessionId : null))
      .toEqual(['fresh', 'new', 'middle', 'old'])
    // The claimed session stays under its task, counted once.
    expect(result.sessionCount).toBe(3)
    expect(result.taskCount).toBe(2)
  })

  test('with no task at all, the sessions still fill the list', () => {
    const result = buildPickerRows({
      tasks: [], query: '', sessionsFor: () => [], expandedTaskIds: new Set(),
      recentSessions: [recent('only', 1_000)],
    })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({ kind: 'conversation', meta: { sessionId: 'only' } })
    // Listed by its date, not found by words: the preview opens on its ends.
    expect(previewHitTarget(result.entries[0])).toBeNull()
  })

  test('the Tasks result type does not list sessions', () => {
    const result = buildPickerRows({
      tasks: [task('a', 'Alpha')], query: '', resultType: 'tasks', sessionsFor: () => [], expandedTaskIds: new Set(),
      recentSessions: [recent('loose', 1_000)],
    })
    expect(result.entries.map((entry) => entry.kind)).toEqual(['task'])
    expect(result.sessionCount).toBe(0)
  })
})


test('tasks result type excludes session matches and expanded session rows', () => {
  const tasks = [task('a', 'Auth task'), task('b', 'Other task')]
  const input = {
    tasks, query: 'auth', resultType: 'tasks' as const,
    sessionsFor: () => [child('s1', 'Auth session')],
    expandedTaskIds: new Set(['a', 'b']),
  }
  const result = buildPickerRows(input)
  expect(result.entries.map((entry) => entry.kind)).toEqual(['task'])
  expect(result.entries[0]).toMatchObject({ task: { id: 'a' }, expanded: false })
  expect(result.sessionCount).toBe(0)
  const emptyQuery = buildPickerRows({ ...input, query: '' })
  expect(emptyQuery.entries.map((entry) => entry.kind)).toEqual(['task', 'task'])
  expect(emptyQuery.sessionCount).toBe(0)
})


test('session identity merges task links, host copies, and passage hits', () => {
  const first = child('same-id', 'Stable name')
  const remote = { ...first, serverId: 'remote' }
  const input = {
    tasks: [task('a', 'Stable task'), task('b', 'Stable task two')],
    query: 'stable', resultType: 'sessions' as const,
    sessionsFor: () => [first, remote, { ...child('', 'Stable placeholder'), sessionId: undefined }],
    expandedTaskIds: new Set<string>(),
  }
  const before = buildPickerRows(input)
  expect(before.entries).toHaveLength(1)
  const result = buildPickerRows({ ...input, conversations: [
    { session: { sessionId: 'same-id', serverId: 'local' } as SessionMeta, snippet: 'stable passage', messageId: 1, rank: -2, ts: 200 },
    { session: { sessionId: 'same-id', serverId: 'local' } as SessionMeta, snippet: 'another stable passage', messageId: 2, rank: -1, ts: 300 },
  ] })
  expect(result.entries).toHaveLength(1)
  expect(result.entries.map((entry) => entry.key)).toEqual(before.entries.map((entry) => entry.key))
  expect(result.entries[0]).toMatchObject({ session: { label: 'Stable name' }, hit: { messageId: 1 }, additionalMatches: [{ messageId: 2 }] })
})


test('copied sessions use passages from one host, preferring the linked host', () => {
  const meta = { sessionId: 'copy', serverId: 'remote', firstMessage: 'Copied session' } as SessionMeta
  const result = buildPickerRows({
    tasks: [task('t', 'Task')], query: 'copy', resultType: 'sessions',
    sessionsFor: () => [child('copy', 'Copied session')], expandedTaskIds: new Set(),
    conversations: [
      { session: meta, snippet: 'remote copy', ts: 1, rank: -5, messageId: 77 },
      { session: { ...meta, serverId: 'local' }, snippet: 'local copy', ts: 1, rank: -1, messageId: 22 },
    ],
  })
  expect(result.entries).toHaveLength(1)
  expect(previewHitTarget(result.entries[0])).toEqual({ serverId: 'local', sessionId: 'copy', messageId: 22 })
  expect(result.entries[0]).toMatchObject({ additionalMatches: [] })
})

describe('search across tasks and sessions', () => {
  const now = Date.UTC(2026, 8, 30)
  const day = 86_400_000

  test('a task found by its comments shows the comment passage and ranks as evidence below a title hit', () => {
    // WHY: a task's discussion is searched (unified-search.md §7); it is what
    // was said about the task, so a task named for the words stays above it.
    const byTitle = { ...task('t', 'Sentry breadcrumbs'), updatedAt: now - 30 * day }
    const byComment = { ...task('c', 'Startup hang'), updatedAt: now }
    const result = buildPickerRows({
      tasks: [byComment, byTitle], query: 'sentry', now, sessionsFor: () => [], expandedTaskIds: new Set(),
      commentPassages: new Map([['c', `the \u0001sentry\u0002 breadcrumb shows a checkpoint`]]),
    })
    expect(result.entries.map((entry) => entry.kind === 'task' ? [entry.task.id, entry.matchedIn] : null)).toEqual([['t', 'title'], ['c', 'comment']])
    expect(result.entries[1]).toMatchObject({ bodySnippet: 'the sentry breadcrumb shows a checkpoint' })
  })

  test('Updated narrows both kinds, Task status narrows tasks, Agent narrows sessions', () => {
    const fresh = { ...task('fresh', 'Fresh task'), updatedAt: now - day / 2 }
    const stale = { ...task('stale', 'Stale task'), updatedAt: now - 40 * day }
    const done = { ...task('done', 'Done task'), status: 'done', updatedAt: now - day / 2 } as Task
    const session = (sessionId: string, provider: string, at: number) =>
      ({ sessionId, serverId: 'local', provider, customTitle: null, firstMessage: sessionId, lastTimestamp: new Date(at).toISOString() }) as unknown as SessionMeta
    const build = (filters: { updated?: 'any' | 'day'; status?: 'any' | 'open' | 'done'; agent?: 'any' | 'codex' }) => buildPickerRows({
      tasks: [fresh, stale, done], query: '', now, sessionsFor: () => [], expandedTaskIds: new Set(),
      recentSessions: [session('claude-new', 'claude-code', now - day / 4), session('codex-old', 'codex', now - 40 * day)],
      filters: { updated: 'any', status: 'any', agent: 'any', host: 'any', ...filters },
    }).entries.map((entry) => entry.kind === 'task' ? entry.task.id : entry.kind === 'conversation' ? entry.meta.sessionId : null)
    expect(build({ updated: 'day' })).toEqual(['claude-new', 'fresh', 'done'])
    expect(build({ status: 'open' })).toEqual(['claude-new', 'fresh', 'stale', 'codex-old'])
    expect(build({ status: 'done' })).toEqual(['claude-new', 'done', 'codex-old'])
    expect(build({ agent: 'codex' })).toEqual(['fresh', 'done', 'stale', 'codex-old'])
  })

  test('Host narrows sessions to one machine and leaves tasks alone', () => {
    // WHY: the reader asks "what ran on that machine". Every way a session
    // reaches the list — its name under a task, a passage a host found, or the
    // newest unclaimed sessions — must answer the same way, and a task is not
    // on any one machine.
    const fixTask = { ...task('fix', 'Fix deploy'), updatedAt: now }
    const onLaptop = { ...child('named-laptop', 'deploy on laptop'), serverId: 'laptop' }
    const onLocal = child('named-local', 'deploy here')
    const meta = (sessionId: string, serverId: string) =>
      ({ sessionId, serverId, customTitle: null, firstMessage: sessionId, lastTimestamp: new Date(now).toISOString() }) as unknown as SessionMeta
    const hit = (sessionId: string, serverId: string) => ({ session: meta(sessionId, serverId), snippet: 'deploy', messageId: 1, rank: -1, ts: now })
    const ids = (query: string, host: string) => buildPickerRows({
      tasks: [fixTask], query, now, sessionsFor: () => [onLaptop, onLocal], expandedTaskIds: new Set(),
      conversations: [hit('said-laptop', 'laptop'), hit('said-local', 'local')],
      recentSessions: [meta('recent-laptop', 'laptop'), meta('recent-local', 'local')],
      filters: { ...NO_PICKER_FILTERS, host },
    }).entries.flatMap((entry) => entry.kind === 'task' ? [entry.task.id] : entry.kind === 'session' ? [entry.session.sessionId] : entry.kind === 'conversation' ? [entry.meta.sessionId] : [])
    expect(ids('deploy', 'laptop').sort()).toEqual(['fix', 'named-laptop', 'said-laptop'].sort())
    expect(ids('', 'laptop').sort()).toEqual(['fix', 'recent-laptop'].sort())
    expect(ids('', 'any').sort()).toEqual(['fix', 'recent-laptop', 'recent-local'].sort())
  })

  test('a session a host found by its name alone is listed with no passage', () => {
    // WHY: a title or a branch is not something said, so there is no passage
    // to show or to open the preview on (unified-search.md §3).
    const named = { session: { sessionId: 'named', serverId: 'local', customTitle: 'Keyboard cheatsheet', lastTimestamp: new Date(now).toISOString() } as SessionMeta, snippet: '', messageId: -1, rank: -100, ts: now }
    const result = buildPickerRows({ tasks: [], query: 'cheatsheet', now, sessionsFor: () => [], expandedTaskIds: new Set(), conversations: [named] })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({ kind: 'conversation', hit: undefined })
    expect(previewHitTarget(result.entries[0]!)).toBeNull()
  })
})
