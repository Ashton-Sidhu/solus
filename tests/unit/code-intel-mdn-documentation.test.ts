import { describe, expect, test } from 'bun:test'
import { mdnArticlePathFrom, mdnDocumentationFor } from '@solus/server/code-intel/mdn-documentation'

describe('mdnDocumentationFor', () => {
  test('names the article MDN emitted for a DOM declaration', () => {
    expect(
      mdnDocumentationFor(
        'scip-typescript npm typescript 5.9.3 lib/`lib.dom.d.ts`/Document#querySelector().',
        'querySelector',
        ['Returns the first matching element.\n\n[MDN Reference](https://developer.mozilla.org/docs/Web/API/Document/querySelector)'],
      ),
    ).toEqual({ provider: 'mdn', kind: 'article', article: 'en-US/docs/Web/API/Document/querySelector' })
  })

  // MDN's search ranks a phrase: "map JavaScript" returns the JavaScript
  // landing pages, while the owner and the name return Array.prototype.map().
  test('searches by owner and name for a standard-library symbol with no exact page', () => {
    expect(
      mdnDocumentationFor(
        'scip-typescript npm typescript 5.9.3 lib/`lib.es5.d.ts`/Array#map().',
        'map',
        ['Calls a callback for every array element.'],
      ),
    ).toEqual({ provider: 'mdn', kind: 'search', query: 'Array map' })
  })

  // Most of the modern standard library lives in the year-named libraries, not
  // in `lib.es5`. A single-digit match sent every one of them to "Defined
  // outside this project" with no reference at all.
  test('covers the year-named standard libraries', () => {
    const cases: [string, string, string][] = [
      ['lib.es2015.core.d.ts', 'NumberConstructor#parseInt().', 'parseInt'],
      ['lib.es2017.object.d.ts', 'ObjectConstructor#entries().', 'entries'],
      ['lib.es2016.array.include.d.ts', 'Array#includes().', 'includes'],
    ]
    for (const [file, descriptor, name] of cases) {
      const owner = descriptor.slice(0, descriptor.indexOf('#'))
      expect(
        mdnDocumentationFor(`scip-typescript npm typescript 5.9.3 lib/\`${file}\`/${descriptor}`, name, []),
      ).toEqual({ provider: 'mdn', kind: 'search', query: `${owner} ${name}` })
    }
  })

  test('searches by name alone when the symbol is top-level in its file', () => {
    expect(
      mdnDocumentationFor('scip-typescript npm typescript 5.9.3 lib/`lib.es5.d.ts`/parseInt().', 'parseInt', []),
    ).toEqual({ provider: 'mdn', kind: 'search', query: 'parseInt' })
  })

  test('does not send an npm package symbol to MDN', () => {
    expect(
      mdnDocumentationFor('scip-typescript npm lodash 4.17.21 map().', 'map', []),
    ).toBeNull()
  })

  // A page path is what both MDN APIs key on, so a link the card cannot turn
  // into one has to fall through to search rather than fetch a 404.
  test('reads an unlocalized link as English and keeps an explicit locale', () => {
    expect(mdnArticlePathFrom('https://developer.mozilla.org/docs/Web/API/Element')).toBe('en-US/docs/Web/API/Element')
    expect(mdnArticlePathFrom('https://developer.mozilla.org/fr/docs/Web/API/Element')).toBe('fr/docs/Web/API/Element')
  })

  test('rejects a link that is not an MDN document', () => {
    expect(mdnArticlePathFrom('https://example.com/docs/Web/API/Element')).toBeNull()
    expect(mdnArticlePathFrom('https://developer.mozilla.org/en-US/blog/something')).toBeNull()
    expect(mdnArticlePathFrom('not a url')).toBeNull()
  })

  test('falls back to search when the emitted link has no article path', () => {
    expect(
      mdnDocumentationFor(
        'scip-typescript npm typescript 5.9.3 lib/`lib.dom.d.ts`/Element#matches().',
        'matches',
        ['See https://developer.mozilla.org/en-US/docs/'],
      ),
    ).toEqual({ provider: 'mdn', kind: 'search', query: 'Element matches' })
  })
})
