import { describe, expect, test } from 'bun:test'
import { nestedRowParents, visibleNestedSessions } from '@solus/workspace-ui/components/session/lib/session-tree'
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
