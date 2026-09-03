import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { CodeIntelSymbolResult } from '@solus/contracts/code-intel'
import { canReuseSymbolAnswer } from '@solus/workspace-ui/components/code-intel/lib/symbol-cache'

const CARD = readFileSync(
  new URL('../../packages/workspace-ui/src/components/code-intel/CodeIntelPopover.svelte', import.meta.url),
  'utf8',
)

describe('symbol card lookup reactivity', () => {
  test('does not subscribe the lookup effect to the reference array it fills', () => {
    // WHY: tracking `loadedReferences.splice(0)` makes the response's later
    // `push` rerun the lookup effect. A ready symbol then asks the host again in
    // a tight loop and freezes the app even when it has only one reference.
    expect(CARD).toContain('untrack(() => {')
    expect(CARD).toContain('loadedReferences.splice(0);')
  })

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
