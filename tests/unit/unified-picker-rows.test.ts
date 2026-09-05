import { describe, expect, test } from 'bun:test'
import type { Task } from '@solus/contracts/task-types'
import type { SessionMeta, SessionSearchResult } from '@solus/contracts/types'
import type { SidebarSessionChild } from '@solus/workspace-ui/contexts/workspace/session-sidebar.store.svelte'
import {
  buildPickerRows,
  collapseTarget,
  expandTarget,
  pickerRowHeight,
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
  snoozedTaskIds: string[] = [],
) {
  return buildPickerRows({
    tasks,
    query,
    sessionsFor: (item) => sessions[item.id] ?? [],
    expandedTaskIds: new Set(expanded),
    openTaskIds: new Set(openTaskIds),
    snoozedTaskIds: new Set(snoozedTaskIds),
  })
}

describe('unified picker rows', () => {
  const tasks = [task('a', 'Alpha'), task('b', 'Beta')]
  const sessions = {
    a: [child('a1', 'first pass'), child('a2', 'second pass')],
    b: [child('b1', 'beta run')],
  }

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

  test('open in-progress and snoozed sidebar tasks are lifted into top sections without duplicates', () => {
    const todo = { ...task('c', 'Gamma'), status: 'todo' as const }
    const { rows } = build([...tasks, todo], sessions, '', [], ['a', 'c'], ['b'])
    expect(rows.filter((row) => row.kind === 'header').map((row) => row.label)).toEqual([
      'Open',
      'Snoozed',
      'Todo',
    ])
    expect(rows.filter((row) => row.kind === 'header').map((row) => row.accent)).toEqual([
      false,
      true,
      false,
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
    expect(rows[0]).toMatchObject({ label: 'Sessions', count: 1, hint: 'newest first' })
    expect(rows[1]).toMatchObject({ session: { sessionId: 'b1' }, task: { id: 'b' }, nested: false })
    expect(sessionCount).toBe(1)
    // A flat session has no parent row to return to.
    expect(collapseTarget(entries, 0)).toBeNull()
  })

  test('sessions the query names are ordered newest first', () => {
    const dated = {
      a: [{ ...child('a1', 'first pass'), lastActivityAt: 10 }, { ...child('a2', 'second pass'), lastActivityAt: 30 }],
      b: [{ ...child('b1', 'beta pass'), lastActivityAt: 20 }],
    }
    const { entries } = build(tasks, dated, 'pass')
    expect(entries.map((entry) => entry.kind === 'session' && entry.session.sessionId)).toEqual([
      'a2', 'b1', 'a1',
    ])
  })

  test('a task matching on its own name keeps all of its sessions behind its fold', () => {
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
    // → still opens it, and the reader's own opening survives the query.
    const opened = build(tasks, sessions, 'alpha', ['a'])
    expect(opened.rows.map((row) => row.kind)).toEqual(['header', 'task', 'session', 'session'])
  })

  test('tasks rank by where they matched: title, then body, then id or status', () => {
    // WHY: "best match first" is the header's promise. Newest-first within a
    // tier is the tiebreak, so the input order (newest first) is kept.
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
    function hit(sessionId: string, snippet: string, serverId = 'local'): SessionSearchResult {
      return {
        session: { sessionId, serverId, firstMessage: `opening of ${sessionId}` } as SessionMeta,
        snippet,
        ts: 0,
      }
    }
    function buildWithHits(query: string, hits: SessionSearchResult[], expanded: string[] = []) {
      return buildPickerRows({
        tasks,
        query,
        sessionsFor: (item) => sessions[item.id] ?? [],
        expandedTaskIds: new Set(expanded),
        conversations: hits,
      })
    }

    test('sessions found by their words follow the tasks as their own section', () => {
      // WHY: the reader searched for what was said, not for a title, so a
      // session no task claims must still be reachable.
      const { rows, entries, conversationCount } = buildWithHits('alpha', [
        hit('orphan', '…the alpha rollout…'),
      ])
      expect(rows.map((row) => row.kind)).toEqual(['header', 'task', 'header', 'conversation'])
      expect(rows[2]).toMatchObject({ kind: 'header', label: 'In conversations', count: 1 })
      expect(entries.at(-1)).toMatchObject({
        kind: 'conversation',
        entryIndex: 1,
        snippet: '…the alpha rollout…',
        task: null,
      })
      expect(conversationCount).toBe(1)
    })

    test('a hit already on screen under its task is not listed twice', () => {
      const hits = [hit('a1', 'alpha again'), hit('b1', 'alpha in beta')]
      const opened = buildWithHits('alpha', hits, ['a'])
      const conversations = opened.rows.filter((row) => row.kind === 'conversation')
      expect(conversations.map((row) => row.meta.sessionId)).toEqual(['b1'])
      // The hit names the task it belongs to, so the row can say so.
      expect(conversations[0]).toMatchObject({ task: { id: 'b' } })
      // Folded away, the same session is off screen, so its hit is listed.
      const folded = buildWithHits('alpha', hits)
      expect(
        folded.rows.filter((row) => row.kind === 'conversation').map((row) => row.meta.sessionId),
      ).toEqual(['a1', 'b1'])
    })

    test('a stale hit list is ignored once the query is cleared', () => {
      const { rows, conversationCount } = buildWithHits('', [hit('orphan', 'left over')])
      expect(rows.some((row) => row.kind === 'conversation')).toBe(false)
      expect(conversationCount).toBe(0)
    })

    test('a conversation row has no parent to collapse into', () => {
      const { entries } = buildWithHits('alpha', [hit('orphan', 'alpha')])
      expect(collapseTarget(entries, entries.length - 1)).toBeNull()
      expect(expandTarget(entries.at(-1))).toBeNull()
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

  test('the footer counts what is listed: every session unqueried, only named sessions under a query', () => {
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
  // row kind with no height, or a touch row shorter than a thumb, would put
  // every row after it in the wrong place.
  test('every row kind has a height and touch rows are never shorter than pointer rows', () => {
    const { rows } = build(tasks, sessions, '', ['a'])
    for (const row of rows) {
      const pointer = pickerRowHeight(row, false)
      const touch = pickerRowHeight(row, true)
      expect(pointer).toBeGreaterThan(0)
      expect(touch).toBeGreaterThanOrEqual(pointer)
      if (row.kind !== 'header') expect(touch).toBeGreaterThanOrEqual(44)
    }
  })

  test('the last session under a task is taller by the nest padding on a pointer display', () => {
    const { rows } = build(tasks, sessions, '', ['a'])
    const [first, last] = rows.filter((row) => row.kind === 'session')
    expect(pickerRowHeight(last, false) - pickerRowHeight(first, false)).toBe(4)
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

  function scoped(projectKey: string | null, query = '') {
    return buildPickerRows({
      tasks: mixed,
      query,
      projectKey,
      sessionsFor: () => [],
      expandedTaskIds: new Set<string>(),
    })
  }

  test('a scope lists only that project and says how much it withheld', () => {
    const list = scoped('model-routing')
    expect(list.entries.map((entry) => entry.task.id)).toEqual(['a', 'c'])
    expect(list.hiddenTaskCount).toBe(1)
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
