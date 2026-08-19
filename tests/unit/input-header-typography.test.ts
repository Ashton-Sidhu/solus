import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const readRendererSource = (path: string) =>
  readFileSync(join(import.meta.dir, '../../packages/workspace-ui/src/components', path), 'utf8')

describe('input header typography', () => {
  test('keeps destination labels compact on laptops', () => {
    // WHY: the destination labels share one row above the composer. Fixed 14px
    // labels crowd that row on a laptop, while the workspace chrome rung stays
    // at 12px there and remains touch-readable on mobile and large displays.
    for (const path of [
      'input/InputBarHeader.svelte',
      'input/ProjectChip.svelte',
      'input/TaskPicker.svelte',
      'servers/RunOnPicker.svelte',
    ]) {
      const source = readRendererSource(path)
      expect(source).toContain('py-1 text-workspace-chrome font-normal')
    }
  })

  test('keeps the destination menus on the same laptop rung', () => {
    // WHY: opening a compact header control must not replace its 12px laptop
    // label with fixed 14px menu rows or a fixed 14px search field.
    for (const path of [
      'GitDropdown.svelte',
      'input/ProjectChip.svelte',
      'input/TaskPicker.svelte',
    ]) {
      const source = readRendererSource(path)
      expect(source).toContain('[&_.menu-row]:text-workspace-chrome')
      expect(source).toContain(
        '[&_[data-slot=command-input]]:text-workspace-chrome',
      )
    }

    const runOnPicker = readRendererSource('servers/RunOnPicker.svelte')
    expect(runOnPicker).toContain(
      'text-workspace-chrome [&_.menu-row]:text-workspace-chrome',
    )
  })
})
