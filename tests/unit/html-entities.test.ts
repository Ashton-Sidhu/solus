import { describe, expect, test } from 'bun:test'
import { decodeHtmlEntities } from '@solus/workspace-ui/components/conversation/lib/html-entities'

describe('HTML entity decoding', () => {
  test('restores common entities emitted as markdown text', () => {
    expect(
      decodeHtmlEntities('Data model &amp; persistence &lt;ready&gt; &quot;now&quot; &#39;ok&#39;'),
    ).toBe('Data model & persistence <ready> "now" \'ok\'')
  })

  test('leaves unknown entities unchanged', () => {
    expect(decodeHtmlEntities('Copyright &copy; 2026')).toBe('Copyright &copy; 2026')
  })
})
