import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const readRendererSource = (path: string) =>
  readFileSync(join(import.meta.dir, '../../packages/workspace-ui/src/components', path), 'utf8')

describe('input toolbar typography', () => {
  test('scales the model, permission, and saved-prompt menus with the display', () => {
    // WHY: these portalled menus must match their input-bar triggers: 14px on
    // large desktops and 12px on precise-pointer laptop displays.
    for (const path of [
      'pickers/PermissionModePicker.svelte',
      'pickers/SessionChip.svelte',
      'input/SavedPromptsControl.svelte',
    ]) {
      const source = readRendererSource(path)
      expect(source).toContain('text-workspace-chrome')
      expect(source).toContain('[&_.menu-row]:text-workspace-chrome')
    }

    const savedPrompts = readRendererSource('input/SavedPromptsControl.svelte')
    expect(savedPrompts).toContain(
      '[&_[data-slot=command-input]]:text-workspace-chrome',
    )
    expect(savedPrompts).toContain('lg:text-workspace-chrome')
  })
})
