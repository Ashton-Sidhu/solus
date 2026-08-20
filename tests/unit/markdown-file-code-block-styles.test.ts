import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const rendererCss = readFileSync(
  join(import.meta.dir, '../../packages/workspace-ui/src/index.css'),
  'utf8',
)

describe('Markdown file code block styles', () => {
  test('uses document code block rules with enough specificity to beat the base editor', () => {
    // WHY: the file surface class is on the editor wrapper. Its override must
    // also name the nested editor class or the three-class base pre rule wins,
    // leaving the file block with its old fill, border, padding, and type size.
    expect(rendererCss).toContain(
      '.markdown-file-document-editor .solus-doc-editor .ProseMirror pre {',
    )
    expect(rendererCss).toContain(
      '.markdown-file-document-editor .solus-doc-editor .doc-code-block--focused pre {',
    )
    expect(rendererCss).not.toContain(
      '.markdown-file-document-editor .ProseMirror pre {',
    )
  })

  test('keeps code content and reduced-motion behavior aligned with documents', () => {
    expect(rendererCss).toContain(
      '.markdown-file-document-editor .solus-doc-editor .ProseMirror pre code {',
    )
    expect(rendererCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.markdown-file-document-editor \.solus-doc-editor \.ProseMirror pre \{[\s\S]*?transition: none !important;/,
    )
  })
})
