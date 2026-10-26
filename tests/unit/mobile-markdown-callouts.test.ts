import { describe, expect, test } from 'bun:test'
import { markdownWithCallouts } from '../../apps/mobile/src/lib/markdownDocument'

// Plan: docs/plans/unified-prose.md, step 3. The phone's renderer has no custom
// block, so a callout shows as a quote led by its kind. The kind must stay
// visible, and nothing that is not a callout may change.

describe('mobile callouts', () => {
  test('a callout leads with its kind in capitals, on its own line', () => {
    expect(markdownWithCallouts('> [!NOTE]\n> Read this.\n\nAfter.')).toBe('> **NOTE**  \n> Read this.\n\nAfter.')
    expect(markdownWithCallouts('> [!warning]\n> One\n>\n> Two')).toBe('> **WARNING**  \n> One\n>\n> Two')
    expect(markdownWithCallouts('> [!TIP]')).toBe('> **TIP**')
  })

  test('quotes, inline markers, and code stay as they are', () => {
    for (const markdown of ['> [!NOTE] aside', '> plain quote', '```\n> [!NOTE]\n```', 'Text with [!NOTE] in it.']) {
      expect(markdownWithCallouts(markdown)).toBe(markdown)
    }
  })
})
