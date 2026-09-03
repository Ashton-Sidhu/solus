import { describe, expect, test } from 'bun:test'
import { leadParagraphOf, parseMdnArticle, parseMdnSearch } from '@solus/server/code-intel/mdn-reader'

describe('leadParagraphOf', () => {
  test('reads the first paragraph as plain text', () => {
    expect(leadParagraphOf('<p>The <code>map()</code> method &amp; friends.</p><p>Second.</p>')).toBe(
      'The map() method & friends.',
    )
  })

  // The card has room for a sentence, and the signature above it already says
  // how the symbol is called; a `<pre>` block is not a summary.
  test('skips code samples to reach real prose', () => {
    expect(leadParagraphOf('<pre class="brush: js"><p>not prose</p></pre><p>Real.</p>')).toBe('Real.')
  })

  test('skips markup that carries no text', () => {
    expect(leadParagraphOf('<p> </p><p><span></span></p><p>Real.</p>')).toBe('Real.')
  })

  test('is empty when there is no paragraph at all', () => {
    expect(leadParagraphOf('<table><tr><td>x</td></tr></table>')).toBe('')
  })
})

describe('parseMdnArticle', () => {
  test('takes the lead prose and the page title', () => {
    expect(
      parseMdnArticle('en-US/docs/Web/API/Document/querySelector', {
        doc: {
          title: 'Document: querySelector() method',
          body: [
            { type: 'prose', value: { content: '<p>Returns the first element that matches.</p>' } },
            { type: 'prose', value: { content: '<p>Ignored, the lead already answered.</p>' } },
          ],
        },
      }),
    ).toEqual({
      title: 'Document: querySelector() method',
      summary: 'Returns the first element that matches.',
      url: 'https://developer.mozilla.org/en-US/docs/Web/API/Document/querySelector',
    })
  })

  // A page whose lead is a compatibility table describes nothing, and the card
  // shows no description rather than a stray fragment.
  test('is null when no prose section has a sentence', () => {
    expect(
      parseMdnArticle('en-US/docs/Web/API/Document', {
        doc: { title: 'Document', body: [{ type: 'browser_compatibility', value: { content: null } }] },
      }),
    ).toBeNull()
  })

  test('is null when the payload is not an MDN document', () => {
    expect(parseMdnArticle('en-US/docs/Web/API/Document', { error: 'not found' })).toBeNull()
  })
})

describe('parseMdnSearch', () => {
  // MDN's search returns a flattened summary with the hit, so the fallback for
  // a symbol with no exact page still costs one request, not two.
  test('takes the best match summary and title', () => {
    expect(
      parseMdnSearch({
        documents: [
          {
            mdn_url: '/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/parseInt',
            title: 'Number.parseInt()',
            summary: 'The Number.parseInt() static method\nparses a string argument.',
          },
          { mdn_url: '/en-US/docs/Web/JavaScript/Reference/Global_Objects/parseInt', title: 'parseInt()', summary: 'Not this one.' },
        ],
      }),
    ).toEqual({
      title: 'Number.parseInt()',
      summary: 'The Number.parseInt() static method parses a string argument.',
      // The link points at the page that answered, not at the token clicked.
      url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/parseInt',
    })
  })

  test('is null when MDN found nothing to describe', () => {
    expect(parseMdnSearch({ documents: [] })).toBeNull()
    expect(parseMdnSearch({ documents: [{ mdn_url: '/en-US/docs/Web/API/X', title: 'A page', summary: '  ' }] })).toBeNull()
    expect(parseMdnSearch(null)).toBeNull()
  })
})
