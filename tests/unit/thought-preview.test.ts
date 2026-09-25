import { describe, expect, test } from 'bun:test'
import type { Message } from '@solus/contracts/types'
import {
  latestThoughtPreview,
  thoughtPreview,
} from '@solus/workspace-ui/components/conversation/lib/thought-preview'

describe('thoughtPreview', () => {
  test('takes the first non-empty line as plain text', () => {
    // WHY: both providers lead a reasoning summary with a bold title. The row is
    // one line of prose, so the title shows without its asterisks and the rest
    // of the thought stays behind it.
    expect(thoughtPreview('\n\n**Inspecting the stylesheet**\n\nThe rule is unlayered.')).toBe(
      'Inspecting the stylesheet',
    )
  })

  test('strips headings, list markers, links and inline code', () => {
    expect(thoughtPreview('## Plan')).toBe('Plan')
    expect(thoughtPreview('- check `index.css` in [the docs](https://example.com)')).toBe(
      'check index.css in the docs',
    )
    expect(thoughtPreview('> _maybe_ the   reset')).toBe('maybe the reset')
  })

  test('skips structure that is not a sentence', () => {
    expect(thoughtPreview('```ts\nconst a = 1')).toBe('const a = 1')
    expect(thoughtPreview('---\nNext step')).toBe('Next step')
  })

  test('is empty when the thought has no readable text', () => {
    // WHY: redacted or encrypted reasoning arrives with no text, and the row
    // must fall back to its plain label rather than print an empty target.
    expect(thoughtPreview(undefined)).toBe('')
    expect(thoughtPreview('   \n  \n')).toBe('')
  })

  test('bounds a runaway first line', () => {
    const preview = thoughtPreview('a'.repeat(1_000))
    expect(preview.length).toBe(240)
    expect(preview.endsWith('…')).toBe(true)
  })
})

describe('latestThoughtPreview', () => {
  function tool(id: string, thinkingPreview?: string): Message {
    return { id, role: 'tool', content: '', timestamp: 0, thinkingPreview }
  }

  test('reports the thought closest to the last step', () => {
    expect(latestThoughtPreview([tool('a', 'First'), tool('b'), tool('c', 'Last'), tool('d')])).toBe('Last')
  })

  test('is empty when no step carries a thought', () => {
    expect(latestThoughtPreview([tool('a'), tool('b')])).toBe('')
  })
})
