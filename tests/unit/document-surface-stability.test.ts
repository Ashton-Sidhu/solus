import { describe, expect, test } from 'bun:test'
import { resizePreviewX } from '@solus/workspace-ui/components/editor/lib/deferred-table-resize'

describe('document surface stability', () => {
  test('column resizing previews the clamped divider without reflowing cells', () => {
    const dragging = { startX: 400, startWidth: 180 }

    expect(resizePreviewX(dragging, 460, 404)).toBe(464)
    expect(resizePreviewX(dragging, 200, 404)).toBe(320)
  })
})
