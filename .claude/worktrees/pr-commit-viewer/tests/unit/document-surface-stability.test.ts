import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { resizePreviewX } from '../../src/renderer/components/editor/lib/deferred-table-resize'

const root = join(import.meta.dir, '../..')
const editorSource = readFileSync(
  join(root, 'src/renderer/components/editor/DocumentEditor.svelte'),
  'utf8',
)
const outlineSource = readFileSync(
  join(root, 'src/renderer/components/document-shell/DocumentOutline.svelte'),
  'utf8',
)

describe('document surface stability', () => {
  test('column resizing cannot change the table outer width', () => {
    expect(editorSource).toMatch(
      /\.solus-doc-editor \.ProseMirror table\)[^{]*\{[\s\S]*?width:\s*100%\s*!important;/,
    )
  })

  test('column resizing previews the clamped divider without reflowing cells', () => {
    const dragging = { startX: 400, startWidth: 180 }

    expect(resizePreviewX(dragging, 460, 404)).toBe(464)
    expect(resizePreviewX(dragging, 200, 404)).toBe(320)
    expect(editorSource).toContain('deferTableResizeReflow(')
  })

  test('the outline uses an opaque document surface while overlapping content', () => {
    const panelStyles = outlineSource.match(/\.doc-outline__panel\s*\{([\s\S]*?)\n\s*\}/)?.[1]

    expect(panelStyles).toContain('background: var(--solus-container-bg);')
    expect(panelStyles).not.toContain('var(--solus-popover-bg)')
  })
})
