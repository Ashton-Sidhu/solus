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
      6,
      noAutomation,
    )
    const icons = rows.map((row) => row.icon)
    expect(new Set(icons).size).toBe(3)
    expect(rows.map((row) => row.kindLabel)).toEqual(['Diagram', 'Slides', 'Doc'])
  })

  test('falls back to the document glyph when the work is gone', () => {
    // WHY: a deleted work has no live type left, so the row still renders from
    // its link-time snapshot rather than losing its glyph.
    const { rows } = railLinkList([workLink('a')], 6, noAutomation)
    expect(rows[0].icon).toBeDefined()
    expect(rows[0].kindLabel).toBe('Doc')
  })
})
