import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const row = readFileSync(join(import.meta.dir, '../../packages/workspace-ui/src/components/settings/SettingsRow.svelte'), 'utf8')

describe('a settings row', () => {
  test('sizes its control column to the control, so a switch leaves its width to the copy', () => {
    // WHY: a fixed 10rem column made a 36px switch hold 160px, and descriptions wrapped early.
    expect(row).toContain('grid-cols-[minmax(0,1fr)_auto]')
    expect(row).not.toContain('minmax(10rem,auto)')
  })

  test('keeps one left edge for dropdowns', () => {
    expect(row).toContain('[&_[data-slot=select-trigger]]:min-w-40')
  })
})
