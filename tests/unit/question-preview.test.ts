import { describe, expect, test } from 'bun:test'
import { previewMarkdown } from '@solus/contracts/question-answer'

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
})
