import { describe, expect, test } from 'bun:test'
import { railLinkList } from '@solus/workspace-ui/components/project-panel/lib/rail-task-card'
import type { TaskLink } from '@solus/contracts/task-types'

function workLink(targetKey: string, liveStatus?: string): TaskLink {
  return {
    taskId: 't1',
    kind: 'work',
    targetScope: '',
    targetKey,
    title: targetKey,
    liveStatus,
    createdBy: 'user',
    linkedAt: 1,
  }
}

const noAutomation = () => undefined

describe('rail Linked glyphs', () => {
  test('gives a diagram, a deck and a document distinct glyphs', () => {
    // WHY: works are one link kind but three artifacts. A reader scanning the
    // rail must tell a diagram from a document without opening either.
    const { rows } = railLinkList(
      [workLink('a', 'diagram'), workLink('b', 'slides'), workLink('c', 'doc')],
      noAutomation,
    )
    const icons = rows.map((row) => row.icon)
    expect(new Set(icons).size).toBe(3)
    expect(rows.map((row) => row.kindLabel)).toEqual(['Diagram', 'Slides', 'Doc'])
  })

  test('falls back to the document glyph when the work is gone', () => {
    // WHY: a deleted work has no live type left, so the row still renders from
    // its link-time snapshot rather than losing its glyph.
    const { rows } = railLinkList([workLink('a')], noAutomation)
    expect(rows[0].icon).toBeDefined()
    expect(rows[0].kindLabel).toBe('Doc')
  })
})

function prLink(targetKey: string, title: string): TaskLink {
  return {
    taskId: 't1',
    kind: 'pr',
    targetScope: '/repo',
    targetKey,
    title,
    createdBy: 'agent',
    linkedAt: 1,
  }
}

describe('rail Linked pull requests', () => {
  test('names a PR whose link snapshot is only its number', () => {
    // WHY: a link written by a path that knew the number and nothing else
    // stores "#65", which the ref column then strips as a duplicate — leaving
    // the row with no name at all. The live title is the only thing that can
    // fill it, so the rail must be reading it.
    const { rows } = railLinkList([prLink('65', '#65')], noAutomation, 1, () =>
      'Show the linked PR title')
    expect(rows[0]).toMatchObject({ ref: '#65', label: 'Show the linked PR title' })
  })

  test('keeps the link snapshot until the PR has been read', () => {
    // WHY: nothing may have loaded that PR yet. The row falls back to what the
    // durable link knows rather than blanking while a read is in flight.
    const { rows } = railLinkList([prLink('65', 'Link-time title')], noAutomation, 1)
    expect(rows[0].label).toBe('Link-time title')
  })
})

describe('rail Linked ordering', () => {
  test('keeps actionable work above newer reference material', () => {
    // WHY: the rail is a compact preview. A pending decision must not disappear
    // below newer documents merely because only four rows fit without scrolling.
    const pendingPlan: TaskLink = {
      taskId: 't1',
      kind: 'plan',
      targetScope: 'session',
      targetKey: 'plan',
      title: 'Pending plan',
      liveStatus: 'pending',
      createdBy: 'agent',
      linkedAt: 1,
    }
    const recentDoc = { ...workLink('Recent document'), linkedAt: 2 }
    const { rows } = railLinkList([recentDoc, pendingPlan], noAutomation, 2)
    expect(rows.map((row) => row.label)).toEqual(['Pending plan', 'Recent document'])
  })

  test('keeps every link available to the bounded scroller', () => {
    // WHY: the rail viewport, not an irreversible expansion state, contains a
    // long list. Scrolling must therefore expose every linked item.
    const links = Array.from({ length: 7 }, (_, index) => ({
      ...workLink(`Document ${index + 1}`),
      linkedAt: index,
    }))
    const { rows } = railLinkList(links, noAutomation, 7)
    expect(rows).toHaveLength(7)
  })
})
