import { describe, expect, test } from 'bun:test'
import { isVerbatimPreview, previewMarkdown } from '@solus/contracts/question-answer'

describe('previewMarkdown', () => {
  test('a mockup shows verbatim, so its columns and leading spaces stay', () => {
    const mockup = '┌──────────┐\n│  Header  │\n|  a  |  b  |\n- not a list\n└──────────┘\n'
    expect(previewMarkdown(mockup)).toBe('```\n┌──────────┐\n│  Header  │\n|  a  |  b  |\n- not a list\n└──────────┘\n```')
  })

  test('a preview with its own fence is markdown the agent wrote', () => {
    const snippet = 'Adds a guard:\n\n```ts\nif (!id) return\n```'
    expect(previewMarkdown(snippet)).toBe(snippet)
    expect(previewMarkdown('~~~\nraw\n~~~')).toBe('~~~\nraw\n~~~')
  })

  test('only a fence makes a preview markdown, so a mockup with table and list lines stays verbatim', () => {
    // WHY: the card renders a markdown preview as prose, which would collapse a
    // mockup's `|` rows into a table and its `-` lines into a list.
    expect(isVerbatimPreview('|  a  |  b  |\n|-----|-----|\n- item')).toBe(true)
    expect(isVerbatimPreview('# Plan\n\n- step one')).toBe(true)
    expect(isVerbatimPreview('Adds a guard:\n\n```ts\nif (!id) return\n```')).toBe(false)
  })
})
