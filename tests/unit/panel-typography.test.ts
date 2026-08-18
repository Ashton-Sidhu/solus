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

  test('steps session task titles down one rung at laptop rail widths', () => {
    // WHY: the step is real — a task title gives up a rung when the rail is
    // tight — but its target moved from 13px to 12px when ADR-0013 retired 13.
    // The step must land on a rung that still exists, not collapse into a
    // self-cancelling `text-sm @max-[…]:text-sm`, which renders no step at all
    // and reports nothing.
    const source = readRendererSource('session/TaskRow.svelte')
    expect(source).toContain('text-sm @max-[15rem]:text-xs')
    expect(source).not.toContain('@max-[15rem]:text-sm')
    expect(source).not.toContain('@max-[13rem]:')
  })

  test('steps project rows down to 12px, with metadata alongside them', () => {
    // WHY: the compact hierarchy keeps the dense project rail useful at the
    // 245–257px widths used by MacBook Pro screens.
    const source = readRendererSource('project-panel/MenuRow.svelte')
    // The rung, not the number: ADR-0013 moved every numeric font-size into
    // index.css, so a literal here would mean the file had drifted back off the
    // scale. `--text-xs` is the same 12px this test always meant.
    expect(source).toMatch(
      /@container \(max-width: 17rem\)\s*{\s*\.menu-row\s*{\s*font-size: var\(--text-xs\);/,
    )
    // WHY: the trail and the hint used to sit at 11px, a rung that existed only
    // to optically match monospace keycaps against 12px sans. Chrome no longer
    // sets type in mono, so the compensation has nothing left to compensate for
    // and both drop onto the 12px rung, separating by colour as the rest of the
    // rail does.
    expect(source).toMatch(/\.menu-trail\s*{[\s\S]*?font-size: var\(--text-xs\);/)
    expect(source).toMatch(/\.menu-hint\s*{[\s\S]*?font-size: var\(--text-xs\);/)
  })

  test('keeps project section labels one rung below their rows', () => {
    // WHY: a section label names the group; the rows are what you read. The
    // label was 11px against 12px rows — a difference nobody could see. It now
    // sits at 12px and separates by weight and colour, and must not drift up to
    // the 14px row rung, which would make the label compete with its contents.
    const source = readRendererSource('project-panel/PanelSection.svelte')
    expect(source).toContain('bg-transparent text-xs font-medium')
    expect(source).not.toContain('bg-transparent text-sm font-medium')
  })

  test('steps Action Orb labels down to 12px on laptop displays', () => {
    const source = readRendererSource('layout/ActionOrb.css')
    expect(source).toMatch(
      /@media \(max-width: 100rem\)\s*{\s*\.action-orb-root\s*{\s*--orb-btn-font: calc\(0\.75rem \* var\(--orb-scale\)\);/,
    )
  })
})
