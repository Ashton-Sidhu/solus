import { describe, expect, it } from 'bun:test'

import { diagramReadOnlyReason, readingHandlers } from '../../packages/workspace-ui/src/components/diagram/lib/reader-mode'

// The host refuses a save from a viewer or a commenter (access-policy.ts), so
// the diagram must open read-only for them and say why — and must stay
// editable for everyone the host lets save, or editors lose their canvas.
describe('diagramReadOnlyReason', () => {
  it('opens a shared diagram read-only for a viewer and a commenter, each told why', () => {
    expect(diagramReadOnlyReason('viewer')).toBe('Shared with you to view.')
    expect(diagramReadOnlyReason('commenter')).toBe('Shared with you to comment and review.')
  })

  it('keeps the canvas editable for an editor, the owner, and a Local work with no share list', () => {
    expect(diagramReadOnlyReason('editor')).toBeNull()
    expect(diagramReadOnlyReason('owner')).toBeNull()
    expect(diagramReadOnlyReason(null)).toBeNull()
  })
})

// The cards offer an edit only when its handler is present. A reader's cards
// must keep what reading needs (actions, the menu, selection, threads) and lose
// every way to change the diagram, or a reader could edit what is never saved.
describe('readingHandlers', () => {
  const noop = () => {}

  it("drops every node edit and keeps the node's reading callbacks", () => {
    const reading = readingHandlers({
      onLabelChange: noop,
      onAction: noop,
      onResize: noop,
      onResizeLive: noop,
      onContextMenu: noop,
      onSelect: noop,
      onToggleCollapse: noop,
      onOpenThread: noop,
    })
    expect(Object.keys(reading).sort()).toEqual(['onAction', 'onContextMenu', 'onOpenThread', 'onSelect', 'resizable'])
    expect(reading.resizable).toBe(false)
  })

  it('drops every edge edit, label and grips alike, and keeps the menu', () => {
    const reading = readingHandlers({
      onLabelChange: noop,
      onLabelOffsetChange: noop,
      onLabelOffsetCommit: noop,
      onBendOffsetChange: noop,
      onBendOffsetCommit: noop,
      onContextMenu: noop,
    })
    expect(Object.keys(reading).sort()).toEqual(['onContextMenu', 'resizable'])
  })
})
