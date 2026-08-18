import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const readRendererSource = (path: string) =>
  readFileSync(join(import.meta.dir, '../../src/renderer/components', path), 'utf8')

const rendererCss = readFileSync(
  join(import.meta.dir, '../../src/renderer/index.css'),
  'utf8',
)

describe('persistent panel typography', () => {
  test('uses one client-display type rung for persistent workspace chrome', () => {
    // WHY: resizing a pane must not resize its text. A 1512px MacBook stays on
    // the compact 12px rung, while large desktop and mobile clients use 14px.
    expect(rendererCss).toContain('--text-workspace-chrome: 0.75rem;')
    expect(rendererCss).toMatch(
      /@media \(min-width: 100rem\), \(max-width: 48rem\) and \(pointer: coarse\)[\s\S]*?--text-workspace-chrome: 0\.875rem;/,
    )

    const breadcrumb = readRendererSource('conversation/SessionBreadcrumb.svelte')
    expect(breadcrumb).toContain('gap-px text-workspace-chrome')
    expect(breadcrumb).not.toContain('@max-[52rem]:text-xs')

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
      expect(source).toContain(`text-left text-workspace-chrome">${label}</span>`)
    }
    expect(source).not.toContain('text-left text-menu')
  })

  test('keeps session task titles stable while the rail resizes', () => {
    // WHY: task titles and navigation share the same workspace-chrome rung;
    // the rail width may change spacing and truncation, but never typography.
    const source = readRendererSource('session/TaskRow.svelte')
    expect(source).toContain('class="text-workspace-chrome')
    expect(source).not.toContain('text-sm @max-[15rem]:text-xs')
  })

  test('keeps project rows on the parent display rung, with compact metadata', () => {
    // WHY: all project cards must agree even when the project rail is resized.
    const panel = readRendererSource('project-panel/ProjectPanel.svelte')
    expect(panel).toContain('font-size: var(--text-workspace-chrome);')

    const source = readRendererSource('project-panel/MenuRow.svelte')
    expect(source).toMatch(/\.menu-row\s*{[\s\S]*?font-size: inherit;/)
    expect(source).not.toMatch(
      /@container \(max-width: 17rem\)[\s\S]*?\.menu-row/,
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

  test('lets compact segmented controls tighten without resizing their labels', () => {
    // WHY: a reusable chrome control may give back padding in a narrow parent,
    // but its label must stay on the client-display type rung.
    const source = readRendererSource('ui/SegmentedControl.svelte')
    expect(source).toContain('@max-[16rem]:px-1.5')
    expect(source).not.toContain('@max-[16rem]:text-xs')
  })

  test('steps Action Orb labels down to 12px on laptop displays', () => {
    const source = readRendererSource('layout/ActionOrb.css')
    expect(source).toMatch(
      /@media \(max-width: 100rem\)\s*{\s*\.action-orb-root\s*{\s*--orb-btn-font: calc\(0\.75rem \* var\(--orb-scale\)\);/,
    )
  })
})
