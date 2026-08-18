import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { enumeratedValues } from '../../src/renderer/components/insights/lib/schema-model'

const SHEET = readFileSync(
  join(import.meta.dir, '../../src/renderer/components/insights/SchemaSheet.svelte'),
  'utf8',
)

describe('schema sheet presentation', () => {
  test('a navigation row centres its label in its own height', () => {
    // The row is a fixed-height box: baseline alignment places its text at the
    // top of the line box, so the label sits off-centre inside its highlight.
    const navRow = SHEET.slice(SHEET.indexOf('{#snippet navRow'), SHEET.indexOf('{#snippet columnRow'))
    expect(navRow).toContain('h-8')
    expect(navRow).toContain('items-center')
    expect(navRow).not.toContain('items-baseline')
  })

  test('a glossed enumerated value states its gloss, rather than hiding it on hover', () => {
    const columnRow = SHEET.slice(SHEET.indexOf('{#snippet columnRow'), SHEET.indexOf('<!-- svelte-ignore'))
    expect(columnRow).toContain('entry.gloss}')
    // A chip carrying its meaning only in `title` cannot be read at all on a
    // touch surface, and is not read on any other.
    expect(columnRow).not.toContain('title={entry.gloss}')
  })

  test('the values a gloss belongs to are the ones the registry writes that way', () => {
    const kind = enumeratedValues("What happened: 'setup' (one Solus setup step), 'thinking' (provider reasoning)")
    expect(kind?.values.every((entry) => entry.gloss.length > 0)).toBe(true)

    const origin = enumeratedValues("Prompt source: 'typed', 'queued', 'automation'")
    expect(origin?.values.every((entry) => entry.gloss === '')).toBe(true)
  })
})
