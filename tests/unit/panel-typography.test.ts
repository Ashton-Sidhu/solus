import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const readRendererSource = (path: string) =>
  readFileSync(join(import.meta.dir, '../../src/renderer/components', path), 'utf8')

describe('persistent panel typography', () => {
  test('keeps session sidebar navigation at the compact 13px size', () => {
    // WHY: the sidebar sits at 245–257px on MacBook Pro screens. The compact
    // menu token keeps its primary destinations proportional to that rail.
    const source = readRendererSource('session/SessionSidebar.svelte')
    for (const label of [
      'Workspace',
      'Automations',
      'Pull requests',
      'Tasks',
      'History',
      'Saved sessions',
      'Settings',
    ]) {
      expect(source).toContain(`text-left text-menu">${label}</span>`)
    }
    expect(source).not.toContain('text-left text-sm')
  })

  test('keeps project rows at 12px and their metadata at 11px', () => {
    // WHY: the compact hierarchy keeps the dense project rail useful at the
    // 245–257px widths used by MacBook Pro screens.
    const source = readRendererSource('project-panel/MenuRow.svelte')
    expect(source).toMatch(/\.menu-row\s*{[\s\S]*?font-size: 0\.75rem;/)
    expect(source).toMatch(/\.menu-trail\s*{[\s\S]*?font-size: var\(--text-menu-meta\);/)
    expect(source).toMatch(/\.menu-hint\s*{[\s\S]*?font-size: var\(--text-menu-meta\);/)
  })

  test('keeps project section labels at 11px', () => {
    const source = readRendererSource('project-panel/PanelSection.svelte')
    expect(source).toContain('bg-transparent text-menu-meta font-medium')
    expect(source).not.toContain('bg-transparent text-xs font-medium')
  })
})
