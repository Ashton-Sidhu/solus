import { describe, expect, test } from 'bun:test'
import { getSchema } from '@tiptap/core'
import { EditorState } from '@tiptap/pm/state'
import { documentExtensions, markdownExtensions } from '@solus/document-model/schema'
import { MermaidBlock } from '@solus/document-model/blocks'
import { setCodeBlockLanguage } from '@solus/workspace-ui/components/editor/lib/code-block-language-command'

const source = 'flowchart LR\n  Desktop[Desktop UI] --> Cloud[Cloud]'

describe('selecting a code block language', () => {
  test('selecting Mermaid renders in works and Markdown files without losing source', () => {
    for (const extensions of [documentExtensions(), [...markdownExtensions(), MermaidBlock]]) {
      const schema = getSchema(extensions)
      const doc = schema.nodes.doc.create(null, schema.nodes.codeBlock.create({ language: 'mermaid source' }, schema.text(source)))
      const transaction = EditorState.create({ schema, doc }).tr
      // Selecting the current Mermaid label also renders a source block.
      expect(setCodeBlockLanguage(transaction, 0, 'mermaid')).toBe(true)
      expect(transaction.doc.firstChild?.type.name).toBe('mermaidBlock')
      expect(transaction.doc.firstChild?.attrs.source).toBe(source)
    }
  })

  test('prompt editors keep Mermaid as code when they cannot render diagrams', () => {
    const schema = getSchema(markdownExtensions())
    const doc = schema.nodes.doc.create(null, schema.nodes.codeBlock.create(null, schema.text(source)))
    const transaction = EditorState.create({ schema, doc }).tr
    expect(setCodeBlockLanguage(transaction, 0, 'mermaid')).toBe(true)
    expect(transaction.doc.firstChild?.type.name).toBe('codeBlock')
    expect(transaction.doc.firstChild?.attrs.language).toBe('mermaid')
    expect(transaction.doc.firstChild?.textContent).toBe(source)
  })

  test('a stale code block position cannot change other content', () => {
    const schema = getSchema(documentExtensions())
    const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text('Keep this text.')))
    const transaction = EditorState.create({ schema, doc }).tr
    expect(setCodeBlockLanguage(transaction, 0, 'mermaid')).toBe(false)
    expect(transaction.doc.eq(doc)).toBe(true)
  })
})
