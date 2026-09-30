import { afterAll, describe, expect, test } from 'bun:test'
import { compileModule } from 'svelte/compiler'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TURN_SORT_CHOICES,
  sortChoiceFor,
  statusFilterFor,
  statusFilterLabel,
} from '@solus/workspace-ui/components/insights/lib/rail-filters'

// The Pull Requests list and the Insights rail fold their narrowing row into
// the crumb line by one rule. These tests encode why each condition exists:
// a reader must never lose the search they are typing in, and a click on a
// row must never be dropped because the list moved under the pointer.

// Runes only exist in compiled Svelte, so the module is compiled the way the
// app compiles it (see diagram-history.test.ts).
const root = new URL('../../', import.meta.url)
const directory = mkdtempSync(join(tmpdir(), 'folding-toolbar-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const source = readFileSync(
  new URL('packages/workspace-ui/src/components/ui/list-page/folding-toolbar.svelte.ts', root),
  'utf8',
)
const compiled = compileModule(new Bun.Transpiler({ loader: 'ts' }).transformSync(source), {
  generate: 'client',
  filename: 'folding-toolbar.svelte.js',
})
  .js.code.replaceAll('svelte/internal/client', new URL('node_modules/svelte/src/internal/client/index.js', root).href)
  .replaceAll(/from ["']svelte["']/g, `from '${new URL('node_modules/svelte/src/index-client.js', root).href}'`)
writeFileSync(join(directory, 'folding-toolbar.mjs'), compiled)
const { FoldingToolbar } = await import(join(directory, 'folding-toolbar.mjs'))

function fold(state: { scrollTop: number; query: string }) {
  return new FoldingToolbar(
    () => state.scrollTop,
    () => !!state.query,
    () => null,
  )
}

describe('folding toolbar', () => {
  test('folds only once the list scrolls past the row', () => {
    const state = { scrollTop: 0, query: '' }
    const toolbar = fold(state)
    expect(toolbar.condensed).toBe(false)
    state.scrollTop = 200
    expect(toolbar.condensed).toBe(true)
  })

  test('stays open while the search holds text, so the query stays visible', () => {
    const toolbar = fold({ scrollTop: 200, query: 'flaky' })
    expect(toolbar.condensed).toBe(false)
  })

  test('stays open while the search has focus', () => {
    const toolbar = fold({ scrollTop: 200, query: '' })
    toolbar.searchFocusChanged(true)
    expect(toolbar.condensed).toBe(false)
    toolbar.searchFocusChanged(false)
    expect(toolbar.condensed).toBe(true)
  })

  test('a blur during a press folds only when the press ends', () => {
    // Folding on pointerdown moves the list under the pointer and the
    // browser drops the click on the row.
    const toolbar = fold({ scrollTop: 200, query: '' })
    toolbar.searchFocusChanged(true)
    toolbar.pressStarted()
    toolbar.searchFocusChanged(false)
    expect(toolbar.condensed).toBe(false)
    toolbar.pressEnded()
    expect(toolbar.condensed).toBe(true)
  })

  test('the crumb search button unfolds the row until the field is left', () => {
    const toolbar = fold({ scrollTop: 200, query: '' })
    toolbar.unfoldSearch()
    expect(toolbar.condensed).toBe(false)
    toolbar.searchFocusChanged(true)
    toolbar.searchFocusChanged(false)
    expect(toolbar.condensed).toBe(true)
  })
})

describe('rail choices', () => {
  test('every sort choice reads back as itself, so a crumb names the sort in use', () => {
    for (const choice of TURN_SORT_CHOICES) expect(sortChoiceFor(choice.sort)).toBe(choice)
  })

  test('a sort set from a table column the menu does not list matches no choice', () => {
    expect(sortChoiceFor({ key: 'model', dir: 'asc' })).toBeNull()
  })

  test('the "all" radio value clears the status filter', () => {
    expect(statusFilterFor('all')).toBeNull()
    expect(statusFilterFor('error')).toBe('error')
    expect(statusFilterLabel(null)).toBe('All turns')
    expect(statusFilterLabel('interrupted')).toBe('Interrupted')
  })
})
