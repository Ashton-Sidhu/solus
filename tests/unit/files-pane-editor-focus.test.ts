import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const root = join(import.meta.dir, '../..')
const readWorkspaceFile = (path: string) =>
  readFileSync(join(root, 'packages/workspace-ui/src', path), 'utf8')

describe('Files pane editor focus', () => {
  test('opening the pane focuses the file-tree search', () => {
    const filesPane = readWorkspaceFile('components/files/FilesPane.svelte')
    const renderTree = filesPane.indexOf('tree.render({ containerWrapper: treeHost })')
    const focusSearch = filesPane.indexOf('tree.openSearch()', renderTree)

    expect(renderTree).toBeGreaterThan(-1)
    expect(focusSearch).toBeGreaterThan(renderTree)
  })

  test('a search keyboard target does not use the selection outline', () => {
    const filesPane = readWorkspaceFile('components/files/FilesPane.svelte')

    expect(filesPane).toContain(
      "[data-file-tree-search-input]:focus)\n          [data-type='item'][data-item-focused='true']:not([data-item-selected='true'])::before",
    )
    expect(filesPane).toContain('outline-color: transparent;')
    expect(filesPane).toContain('background-color: var(--trees-bg-muted);')
  })

  test('a file selected in the tree receives editor focus after it opens', () => {
    const filesPane = readWorkspaceFile('components/files/FilesPane.svelte')
    const markdownSurface = readWorkspaceFile('components/files/MarkdownFileSurface.svelte')
    const filePreview = readWorkspaceFile('components/artifact/FilePreviewStream.svelte')

    expect(filesPane).toContain('void openFile(next, true)')
    const waitForSvelte = filesPane.indexOf('await tick()')
    const waitForTree = filesPane.indexOf('requestAnimationFrame(() => {', waitForSvelte)
    const focusMarkdown = filesPane.indexOf('markdownSurfaceRef?.focus()', waitForTree)

    expect(waitForSvelte).toBeGreaterThan(-1)
    expect(waitForTree).toBeGreaterThan(waitForSvelte)
    expect(focusMarkdown).toBeGreaterThan(waitForTree)
    expect(filesPane).toContain('markdownSurfaceRef?.focus()')
    expect(filesPane).toContain('filePreviewRef?.focus()')
    expect(markdownSurface).toContain('export function focus()')
    expect(filePreview).toContain('export function focus()')
    expect(filePreview).toContain('shouldFocusWhenReady = true')
    expect(filePreview.match(/editor\.focus\(\{ lineNumber: "first-visible", preventScroll: true \}\)/g)).toHaveLength(2)
  })
})
