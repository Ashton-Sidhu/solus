import { describe, expect, test } from 'bun:test'
import { delegatedRows, nestedRowParents, nestedStateMarks, visibleNestedSessions } from '@solus/workspace-ui/components/session/lib/session-tree'
import type { SidebarTask } from '@solus/workspace-ui/components/session/lib/task-list'

type Row = Pick<SidebarTask, 'id' | 'lifecycle'>

function active(id: string): Row {
  return { id, lifecycle: 'active' }
}

describe('sidebar session tree', () => {
  test('a delegated session nests under the row of the session that started it', () => {
    // WHY: an agent that delegates work starts sessions the user did not open.
    // Listing each one as a peer of its parent loses who started what.
    const parents = nestedRowParents(
      [active('parent-tab'), active('child-tab')],
      new Map([['child-tab', 'parent-session']]),
      new Map([['parent-session', 'parent-tab'], ['child-session', 'child-tab']]),
    )
    expect([...parents]).toEqual([['child-tab', 'parent-tab']])
  })

  test('a chain of delegations nests under its top row, one level deep', () => {
    const parents = nestedRowParents(
      [active('root'), active('child'), active('grandchild')],
      new Map([['child', 'root-session'], ['grandchild', 'child-session']]),
      new Map([['root-session', 'root'], ['child-session', 'child'], ['grandchild-session', 'grandchild']]),
    )
    expect(parents.get('child')).toBe('root')
    expect(parents.get('grandchild')).toBe('root')
  })

  test('a session whose parent has no row keeps its own row', () => {
    // WHY: nesting changes where a session is listed. It must never hide one.
    const parents = nestedRowParents(
      [active('child')],
      new Map([['child', 'closed-parent-session']]),
      new Map([['child-session', 'child']]),
    )
    expect(parents.size).toBe(0)
  })

  test('a parent on a shelf takes no children, so the child stays visible', () => {
    // WHY: shelved rows are slim and draw no sessions under them.
    const parents = nestedRowParents(
      [{ id: 'parent', lifecycle: 'snoozed' }, active('child')],
      new Map([['child', 'parent-session']]),
      new Map([['parent-session', 'parent']]),
    )
    expect(parents.size).toBe(0)
  })

  test('a cycle nests nothing', () => {
    const parents = nestedRowParents(
      [active('a'), active('b')],
      new Map([['a', 'b-session'], ['b', 'a-session']]),
      new Map([['a-session', 'a'], ['b-session', 'b']]),
    )
    expect(parents.size).toBe(0)
  })

  test('a collapsed row hides its delegated sessions but not the one on screen', () => {
    // WHY: a click on the parent folds its tree away, but folding must never
    // hide the session the user is reading.
    const nested = [{ tabId: 'a' }, { tabId: 'b' }, {}]
    expect(visibleNestedSessions(nested, false, 'b')).toEqual(nested)
    expect(visibleNestedSessions(nested, true, null)).toEqual([])
    expect(visibleNestedSessions(nested, true, 'b')).toEqual([{ tabId: 'b' }])
  })
})

describe('the marks a row stacks for the sessions it started', () => {
  test('each state once, what wants the person first, then unread, then working', () => {
    // WHY: a folded drawer must not hide a session that asks a question or
    // has finished unread. The stack is a summary, so a state appears once
    // however many sessions share it.
    expect(
      nestedStateMarks([
        { attention: 'running', unread: false },
        { attention: 'idle', unread: true },
        { attention: 'running', unread: true },
        { attention: 'awaiting', unread: false },
      ]),
    ).toEqual([{ kind: 'glyph', status: 'question' }, { kind: 'unread' }, { kind: 'spinner' }])
  })

  test('quiet sessions add no mark', () => {
    expect(nestedStateMarks([{ attention: 'idle', unread: false }])).toEqual([])
  })

})

describe('delegated rows', () => {
  test('the rows a settle or archive carries are every delegated session under it, at any depth', () => {
    // WHY: a finished session's delegated sessions must leave the list with
    // it. Left behind, they lose their parent row and show as rows of their own.
    const sessions = new Map([
      ['root', { id: 'root-session' }],
      ['child', { id: 'child-session', parentSessionId: 'root-session' }],
      ['grandchild', { id: 'grandchild-session', parentSessionId: 'child-session' }],
      ['other-child', { id: 'other-session', parentSessionId: 'other-root-session' }],
      ['cycle', { id: 'child-session', parentSessionId: 'grandchild-session' }],
    ])
    const rows = ['grandchild', 'root', 'other-child', 'child', 'cycle']
    expect(delegatedRows('root-session', rows, (row) => sessions.get(row) ?? null)).toEqual(['child', 'grandchild'])
    expect(delegatedRows('child-session', rows, (row) => sessions.get(row) ?? null)).toEqual(['grandchild'])
  })
})
