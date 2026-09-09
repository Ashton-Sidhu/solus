import { describe, expect, test } from 'bun:test'
import type { CodeIntelSymbolResult } from '@solus/contracts/code-intel'
import { canReuseSymbolAnswer } from '@solus/workspace-ui/components/code-intel/lib/symbol-cache'

describe('symbol card lookup reactivity', () => {
  test('reuses a stale symbol until the index transition clears the cache', () => {
    // WHY: the host already broadcasts both ends of a rebuild. Rejecting the
    // answer between those events turns any repeated reactive read into another
    // RPC even though every request returns the same old-index symbol.
    const staleSymbol = {
      ok: true,
      symbol: {
        symbol: 'local 1',
        name: 'value',
        kind: 'variable',
        language: 'typescript',
        documentation: [],
        externalDocumentation: null,
        definition: null,
        references: [],
        referenceCount: 1,
        referenceFileCount: 1,
      },
      language: null,
      freshness: 'stale',
    } satisfies CodeIntelSymbolResult

    expect(canReuseSymbolAnswer(staleSymbol)).toBeTrue()
    expect(canReuseSymbolAnswer({ ok: false, error: 'offline' })).toBeFalse()
  })
})
