import { describe, expect, test } from 'bun:test'
import type {
  CodeIntelLanguageStatus,
  CodeIntelReference,
  CodeIntelSymbol,
  CodeIntelSymbolResult,
} from '@solus/contracts/code-intel'
import {
  cardNotice,
  groupReferences,
  hasUsefulSymbolAnswer,
  isAtDefinition,
  locationLabel,
  mdnReferenceFor,
  previewSegments,
  REFERENCE_ROWS_PER_FILE,
  referenceSummary,
  referenceListItems,
  signatureParts,
  splitDocumentation,
  symbolAvailability,
} from '@solus/workspace-ui/components/code-intel/lib/symbol-card'
import { languageForPath } from '@solus/server/code-intel/adapters'

/**
 * The card's footer is the feature's honesty line: it must name why an answer
 * is missing or shaky, and stay silent only when the index is current.
 */

function language(overrides: Partial<CodeIntelLanguageStatus>): CodeIntelLanguageStatus {
  return {
    language: 'typescript',
    label: 'TypeScript',
    detected: true,
    toolName: 'scip-typescript',
    toolInstalled: true,
    installCommand: 'npm install -g @sourcegraph/scip-typescript',
    state: 'ready',
    indexedAt: 1,
    documentCount: 1,
    error: null,
    ...overrides,
  }
}

function answer(status: CodeIntelLanguageStatus | null, freshness: 'fresh' | 'stale' = 'fresh'): CodeIntelSymbolResult {
  return { ok: true, symbol: null, language: status, freshness }
}

const indexedSymbol: CodeIntelSymbol = {
  symbol: 'scip-typescript npm example 1.0.0 src/index.ts/foo.',
  name: 'foo',
  kind: 'constant',
  language: 'typescript',
  documentation: [],
  externalDocumentation: null,
  definition: null,
  references: [],
  referenceCount: 0,
  referenceFileCount: 0,
}

describe('mdnReferenceFor', () => {
  const reference = { provider: 'mdn', kind: 'article', article: 'en-US/docs/Web/API/Document' } as const

  test('describes a platform symbol the indexer left undescribed', () => {
    expect(mdnReferenceFor({ ...indexedSymbol, externalDocumentation: reference })).toEqual(reference)
  })

  // TypeScript's DOM declarations already carry MDN's own sentence. Fetching a
  // second copy of it would cost a round trip and say nothing new.
  test('leaves a symbol that already has a doc comment alone', () => {
    expect(
      mdnReferenceFor({
        ...indexedSymbol,
        documentation: ['```ts\nfoo(): void\n```', 'Returns the first matching element.'],
        externalDocumentation: reference,
      }),
    ).toBeNull()
  })

  // A signature is not a description: it is already rendered above the prose.
  test('still fetches when the only documentation is the signature', () => {
    expect(
      mdnReferenceFor({
        ...indexedSymbol,
        documentation: ['```ts\nfoo(): void\n```'],
        externalDocumentation: reference,
      }),
    ).toEqual(reference)
  })

  test('is null for a symbol with no platform reference', () => {
    expect(mdnReferenceFor(indexedSymbol)).toBeNull()
    expect(mdnReferenceFor(null)).toBeNull()
  })
})

describe('hasUsefulSymbolAnswer', () => {
  test('rejects lexical words that SCIP did not identify', () => {
    expect(hasUsefulSymbolAnswer(answer(language({})))).toBeFalse()
  })

  test('rejects an external symbol with no useful information or target', () => {
    expect(
      hasUsefulSymbolAnswer({ ok: true, symbol: indexedSymbol, language: language({}), freshness: 'fresh' }),
    ).toBeFalse()
  })

  test('accepts a constant with a project definition', () => {
    expect(
      hasUsefulSymbolAnswer({
        ok: true,
        symbol: {
          ...indexedSymbol,
          definition: {
            path: 'src/index.ts',
            range: { startLine: 0, startCharacter: 6, endLine: 0, endCharacter: 9 },
          },
        },
        language: language({}),
        freshness: 'fresh',
      }),
    ).toBeTrue()
  })

  test('rejects failed lookups', () => {
    expect(hasUsefulSymbolAnswer({ ok: false, error: 'offline' })).toBeFalse()
  })
})

describe('symbolAvailability', () => {
  const projectSymbol: CodeIntelSymbol = {
    ...indexedSymbol,
    definition: { path: 'src/index.ts', range: { startLine: 0, startCharacter: 6, endLine: 0, endCharacter: 9 } },
  }

  test('a useful answer earns the underline and opens the card', () => {
    expect(symbolAvailability({ ok: true, symbol: projectSymbol, language: language({}), freshness: 'fresh' })).toBe('symbol')
  })

  test('a plain miss on a current index stays silent, so a word in a string does nothing', () => {
    expect(symbolAvailability(answer(language({})))).toBe('none')
  })

  test('an index with something to say opens the card on an explicit gesture only', () => {
    expect(symbolAvailability(answer(language({ state: 'tool-missing', toolInstalled: false })))).toBe('status')
    expect(symbolAvailability(answer(language({ state: 'not-indexed', detected: false })))).toBe('status')
    expect(symbolAvailability(answer(language({ state: 'error', error: 'boom' })))).toBe('status')
    expect(symbolAvailability(answer(null))).toBe('status')
    expect(symbolAvailability({ ok: false, error: 'offline' })).toBe('status')
  })

  // The index toast narrates the whole run. An identifier that would open a
  // card carrying nothing but a second copy of that sentence stays silent.
  test('a miss while the index builds stays silent, because the toast already says so', () => {
    expect(symbolAvailability(answer(language({ state: 'indexing' })))).toBe('none')
    expect(symbolAvailability(answer(language({ state: 'not-indexed' })))).toBe('none')
  })
})

describe('isAtDefinition', () => {
  const definition = { path: 'src/index.ts', range: { startLine: 4, startCharacter: 0, endLine: 4, endCharacter: 3 } }

  test('matches the declaration line whether the surface names the file relatively or absolutely', () => {
    expect(isAtDefinition({ path: 'src/index.ts', line: 4 }, definition)).toBeTrue()
    expect(isAtDefinition({ path: '/home/me/project/src/index.ts', line: 4 }, definition)).toBeTrue()
  })

  test('a call site on another line is not the definition', () => {
    expect(isAtDefinition({ path: 'src/index.ts', line: 9 }, definition)).toBeFalse()
    expect(isAtDefinition({ path: 'src/other.ts', line: 4 }, definition)).toBeFalse()
  })
})

describe('groupReferences', () => {
  const at = (path: string, line: number): CodeIntelReference => ({
    path,
    range: { startLine: line, startCharacter: 0, endLine: line, endCharacter: 1 },
    preview: null,
  })
  const lines = (group: { rows: { line: number }[] }) => group.rows.map((row) => row.line)

  test('folds references into files, sorts lines, and puts the current file first', () => {
    const groups = groupReferences(
      [at('src/b.ts', 9), at('src/a.ts', 20), at('src/b.ts', 2), at('src/a.ts', 20), at('src/a.ts', 3)],
      '/repo/src/a.ts',
    )
    expect(groups.map((group) => group.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(groups[0]).toMatchObject({ name: 'a.ts', dir: 'src/', isCurrentFile: true })
    expect(lines(groups[0]!)).toEqual([4, 21])
    expect(groups[1]).toMatchObject({ name: 'b.ts', isCurrentFile: false })
    expect(lines(groups[1]!)).toEqual([3, 10])
  })

  test('keeps the index order of files that are not the current one', () => {
    const groups = groupReferences([at('z.ts', 1), at('m.ts', 1)], 'a.ts')
    expect(groups.map((group) => group.path)).toEqual(['z.ts', 'm.ts'])
  })

  test('carries each line its own source text so a row reads as code', () => {
    const preview = { text: 'const parts = formatLocation(loc)', matchStart: 14, matchEnd: 28 }
    const [group] = groupReferences([{ ...at('src/a.ts', 4), preview }], 'src/b.ts')
    expect(group!.rows[0]!.preview).toBe(preview)
    expect(previewSegments(preview)).toEqual({
      before: 'const parts = ',
      match: 'formatLocation',
      after: '(loc)',
    })
  })

  test('a file with many references keeps the card scannable and offers the rest', () => {
    const busy = Array.from({ length: 12 }, (_, index) => at('src/busy.ts', index))
    const [group] = groupReferences(busy, 'src/other.ts')
    // The card shows a slice; the group still carries every row so the
    // expander has something to reveal.
    expect(group!.rows).toHaveLength(12)
    expect(group!.rows.length - REFERENCE_ROWS_PER_FILE).toBe(7)
  })

  test('flattens visible rows and keeps a paged continuation in display order', () => {
    const groups = groupReferences(
      [at('src/a.ts', 1), ...Array.from({ length: 7 }, (_, index) => at('src/b.ts', index))],
      'src/a.ts',
    )
    const items = referenceListItems(groups, new Set(), 92, false)
    expect(items.map((item) => item.kind)).toEqual([
      'header',
      'reference',
      'header',
      'reference',
      'reference',
      'reference',
      'reference',
      'reference',
      'toggle',
      'load-more',
    ])
    expect(items.at(-1)).toEqual({
      kind: 'load-more',
      key: 'load-more',
      remaining: 92,
      isLoading: false,
      hasError: false,
    })
  })
})

describe('signatureParts', () => {
  test('weights the name inside the signature the indexer wrote', () => {
    expect(signatureParts('function formatLocation(location: Location): LocationParts', 'formatLocation', 'function')).toEqual({
      keyword: 'function',
      name: 'formatLocation',
      rest: '(location: Location): LocationParts',
    })
  })

  test('a name that is a substring of a longer word is not the split point', () => {
    expect(signatureParts('const formatLocationCache: Map<string, Location>', 'Location', 'variable')).toEqual({
      keyword: 'const formatLocationCache: Map<string,',
      name: 'Location',
      rest: '>',
    })
  })

  test('with no signature the kind stands in for the keyword', () => {
    expect(signatureParts(null, 'LocationParts', 'interface')).toEqual({
      keyword: 'interface',
      name: 'LocationParts',
      rest: '',
    })
  })

  test('a signature that never names the symbol is shown whole rather than mis-split', () => {
    expect(signatureParts('(alias) type Foo', 'Bar', 'type')).toEqual({ keyword: '', name: '(alias) type Foo', rest: '' })
  })
})

describe('referenceSummary', () => {
  test('names both numbers, because spread and volume are different problems', () => {
    expect(referenceSummary(92, 2)).toBe('92 references in 2 files')
    expect(referenceSummary(1, 1)).toBe('1 reference in 1 file')
  })
})

describe('cardNotice', () => {
  test('a current index with an answer needs no notice', () => {
    expect(cardNotice(answer(language({})), 'fresh')).toBeNull()
  })

  test('a missing tool names the tool and hands over the install command', () => {
    const notice = cardNotice(answer(language({ state: 'tool-missing', toolInstalled: false })), 'fresh')!
    expect(notice.text).toContain('scip-typescript')
    expect(notice.command).toBe('npm install -g @sourcegraph/scip-typescript')
  })

  // The build has its own progress toast for the whole run. A second copy of
  // that sentence inside the card is noise, not honesty.
  test('a build in progress leaves the notice to the index toast', () => {
    expect(cardNotice(answer(language({ state: 'indexing' })), 'fresh')).toBeNull()
    expect(cardNotice(answer(language({ state: 'not-indexed' })), 'fresh')).toBeNull()
  })

  test('a root with no project markers offers a rebuild, because no toast is coming', () => {
    expect(cardNotice(answer(language({ state: 'not-indexed', detected: false })), 'fresh')).toMatchObject({
      action: 'reindex',
    })
  })

  test('a stale file says positions may drift instead of hiding the answer', () => {
    expect(cardNotice(answer(language({}), 'stale'), 'stale')?.text).toContain('changed since')
  })

  test('a failed build offers a retry', () => {
    expect(cardNotice(answer(language({ state: 'error', error: 'tsc exploded' })), 'fresh')).toMatchObject({
      tone: 'warning',
      text: 'tsc exploded',
      action: 'retry',
    })
  })

  test('a file no indexer covers says so', () => {
    expect(cardNotice(answer(null), 'fresh')?.text).toContain('No indexer')
  })
})

describe('splitDocumentation', () => {
  test('lifts the fenced signature out of the leading paragraph', () => {
    expect(splitDocumentation(['```ts\nfunction add(a: number): number\n```', 'Adds.'])).toEqual({
      signature: 'function add(a: number): number',
      description: ['Adds.'],
    })
  })

  test('leaves prose alone when there is no fence', () => {
    expect(splitDocumentation(['Just words'])).toEqual({ signature: null, description: ['Just words'] })
  })
})

describe('locationLabel', () => {
  test('splits directory from file and shows a 1-based line', () => {
    expect(locationLabel({ path: 'src/lib/math.ts', range: { startLine: 4, startCharacter: 0, endLine: 4, endCharacter: 3 } })).toEqual({
      dir: 'src/lib/',
      name: 'math.ts',
      line: 5,
    })
  })
})

describe('languageForPath', () => {
  test('maps every shipped extension and nothing else', () => {
    expect(languageForPath('a/b.tsx')).toBe('typescript')
    expect(languageForPath('a/b.mjs')).toBe('typescript')
    expect(languageForPath('a/b.pyi')).toBe('python')
    expect(languageForPath('a/b.go')).toBe('go')
    expect(languageForPath('a/b.rs')).toBe('rust')
    expect(languageForPath('a/b.svelte')).toBeNull()
    expect(languageForPath('Makefile')).toBeNull()
  })
})
