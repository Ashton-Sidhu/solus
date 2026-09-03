import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { CodeIntelIndex } from '@solus/server/code-intel/index-store'
import { decodeScipIndex, type ScipIndex } from '@solus/server/code-intel/scip-decoder'
import { CODE_INTEL_REFERENCE_PAGE_SIZE } from '@solus/contracts/code-intel'

/**
 * What a click must answer: the symbol under the caret, where it is defined,
 * who else uses it, and what to show as hover. The fixture is real
 * scip-typescript output, so positions are the indexer's, not ours.
 */

const FIXTURE_ROOT = join(import.meta.dir, '__fixtures__', 'scip', 'typescript-project')

function loadStore(): CodeIntelIndex {
  const index = decodeScipIndex(new Uint8Array(readFileSync(join(FIXTURE_ROOT, 'index.scip'))))
  return CodeIntelIndex.fromScip('typescript', index)
}

describe('CodeIntelIndex.symbolAt', () => {
  test('a reference in main.ts resolves to the definition in math.ts', () => {
    // main.ts line 3: `counter.increment(add(1, 2))` — `add` starts at column 18.
    const symbol = loadStore().symbolAt('src/main.ts', 3, 19)!
    expect(symbol).not.toBeNull()
    expect(symbol.name).toBe('add')
    expect(symbol.kind).toBe('function')
    expect(symbol.definition).toEqual({
      path: 'src/math.ts',
      range: { startLine: 1, startCharacter: 16, endLine: 1, endCharacter: 19 },
    })
    expect(symbol.documentation.join('\n')).toContain('Adds two numbers')
  })

  test('references exclude the definition and count every other site', () => {
    const symbol = loadStore().symbolAt('src/math.ts', 1, 17)!
    // WHY: the card lists "where else is this used"; the definition is shown
    // separately, so listing it again would count itself as a caller.
    expect(symbol.references.every((location) => !(location.path === 'src/math.ts' && location.range.startLine === 1))).toBe(true)
    expect(symbol.referenceCount).toBe(symbol.references.length)
    expect(symbol.references.map((location) => location.path).sort()).toEqual(['src/main.ts', 'src/main.ts', 'src/math.ts'])
  })

  test('reference pages continue from an offset without changing the full count', () => {
    const store = loadStore()
    const symbol = store.symbolAt('src/math.ts', 1, 17)!
    const page = store.referencesFor(symbol.symbol, 1)
    // WHY: later pages must not repeat the initial hover payload, and the card
    // still needs the full count to know when every call site has arrived.
    expect(page.referenceCount).toBe(3)
    expect(page.references).toEqual(symbol.references.slice(1).map(({ path, range }) => ({ path, range })))
    expect(page.nextOffset).toBeNull()
  })

  test('a method occurrence is classified by its descriptor when kind is unset', () => {
    // math.ts line 8: `  increment(by: number): number {`
    const symbol = loadStore().symbolAt('src/math.ts', 8, 5)!
    expect(symbol.name).toBe('increment')
    expect(symbol.kind).toBe('method')
  })

  test('whitespace between tokens has no symbol', () => {
    // math.ts line 2: `  return a + b` — column 10 is the space after `a`.
    expect(loadStore().symbolAt('src/math.ts', 2, 10)).toBeNull()
  })

  test('the end of a range is exclusive so the next token is not stolen', () => {
    // `add(` on line 1 of math.ts spans [16, 19); column 19 is the paren.
    expect(loadStore().symbolAt('src/math.ts', 1, 19)).toBeNull()
  })

  test('an unknown file answers null instead of throwing', () => {
    expect(loadStore().symbolAt('src/missing.ts', 0, 0)).toBeNull()
    expect(loadStore().hasDocument('src/main.ts')).toBe(true)
    expect(loadStore().documentCount).toBe(2)
  })

  test('project symbols do not claim external documentation', () => {
    expect(loadStore().symbolAt('src/main.ts', 3, 19)?.externalDocumentation).toBeNull()
  })
})

describe('local symbols', () => {
  test('the same local id in two documents is two bindings', () => {
    // WHY: SCIP numbers `local N` per document, so the id alone is not an
    // identity. Keyed on the id, every local in a project shares one bucket —
    // in this repo's own index that put 68,079 occurrences into 1,540 ids, and
    // gave a single loop variable 1,584 references across 554 unrelated files.
    // The card then lied about the call sites and paged through hundreds of
    // them for a binding that never left its function.
    const local = 'local 0'
    const line = (path: string, startLine: number, symbolRoles: number) => ({
      relativePath: path,
      language: 'typescript',
      positionEncoding: 2,
      symbols: [],
      occurrences: [
        { symbol: local, symbolRoles: 1, range: { startLine, startCharacter: 0, endLine: startLine, endCharacter: 5 } },
        { symbol: local, symbolRoles, range: { startLine: startLine + 1, startCharacter: 0, endLine: startLine + 1, endCharacter: 5 } },
      ],
    })
    const index: ScipIndex = {
      projectRoot: '',
      toolName: 'test',
      toolVersion: '1',
      externalSymbols: [],
      documents: [line('src/one.ts', 0, 0), line('src/two.ts', 10, 0)],
    }
    const store = CodeIntelIndex.fromScip('typescript', index)

    const one = store.symbolAt('src/one.ts', 1, 2)!
    const two = store.symbolAt('src/two.ts', 11, 2)!
    expect(one.symbol).not.toBe(two.symbol)
    expect(one.definition).toEqual({
      path: 'src/one.ts',
      range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 5 },
    })
    expect(one.referenceCount).toBe(1)
    expect(one.references.map((location) => location.path)).toEqual(['src/one.ts'])
    expect(store.referencesFor(two.symbol, 0).references.map((location) => location.path)).toEqual(['src/two.ts'])
  })
})

describe('CodeIntelIndex.referencesFor', () => {
  test('caps each page and reaches every call site', () => {
    const symbol = 'scip-typescript npm sample 1.0.0 src/api.ts/useApi().'
    const referenceCount = CODE_INTEL_REFERENCE_PAGE_SIZE * 2 + 5
    const index: ScipIndex = {
      projectRoot: '',
      toolName: 'test',
      toolVersion: '1',
      externalSymbols: [],
      documents: [{
        relativePath: 'src/calls.ts',
        language: 'typescript',
        positionEncoding: 2,
        symbols: [],
        occurrences: Array.from({ length: referenceCount }, (_, line) => ({
          symbol,
          symbolRoles: 0,
          range: { startLine: line, startCharacter: 0, endLine: line, endCharacter: 6 },
        })),
      }],
    }
    const store = CodeIntelIndex.fromScip('typescript', index)
    const first = store.referencesFor(symbol, 0)
    const second = store.referencesFor(symbol, first.nextOffset!)
    const third = store.referencesFor(symbol, second.nextOffset!)

    // WHY: virtualization cannot recover references that never crossed the
    // transport. Fixed pages must cover the full index with no overlap.
    expect([first.references.length, second.references.length, third.references.length]).toEqual([100, 100, 5])
    expect([first.nextOffset, second.nextOffset, third.nextOffset]).toEqual([100, 200, null])
    expect(third.referenceCount).toBe(referenceCount)
  })
})
