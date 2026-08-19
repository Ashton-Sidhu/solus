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
    // WHY: resizing a pane must not resize its text. Laptop workspace chrome
    // uses the compact 12px rung, while large desktop and coarse-pointer mobile
    // clients retain the readable 14px rung.
    expect(rendererCss).toContain('--text-workspace-chrome: 0.875rem;')
    expect(rendererCss).toMatch(
      /@media \(pointer: fine\)[\s\S]*?html\.is-laptop-display\s*{[\s\S]*?--text-workspace-chrome: 0\.75rem;/,
    )

    const breadcrumb = readRendererSource('conversation/SessionBreadcrumb.svelte')
    expect(breadcrumb).toContain('gap-px text-workspace-chrome {variant ===')
    // The crumb bar is one surface and its three menus are another. A menu is
    // portalled onto document.body, so it sits outside the bar that opened it
    // and inherits nothing — it has to name its own rung. That is the one case
    // where declaring is right, and it is why these three exist at all.
    //
    // They used to name it by overwriting `--text-workspace-chrome` inline,
    // which meant each menu restated the laptop and coarse-pointer boundary and
    // could drift from the other two. Same density, said once in index.css.
    expect(breadcrumb.match(/text-chrome-dense/g)).toHaveLength(3)
    expect(breadcrumb).not.toContain('[--text-workspace-chrome:')
    expect(breadcrumb).toContain(
      'text-workspace-chrome font-medium whitespace-nowrap @max-[36rem]:hidden',
    )
    // Rows and the command input live inside a menu, so they take its rung.
    // `menuLabel` is shared by all three menus — one of them via a snippet
    // declared above them in the file — so a size here would outrank whichever
    // menu rendered it.
    expect(breadcrumb).toContain(
      'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap',
    )
    expect(breadcrumb).not.toContain('[&_[data-slot=command-input]]:')
    expect(breadcrumb).not.toContain('class="flex-1 text-sm"')
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
    // WHY: the trail remains fixed metadata, while the hint is a shared keycap
    // that follows the compact shortcut rung on laptop displays. MenuRow must
    // not recreate either the component or its laptop branch locally.
    expect(source).toMatch(/\.menu-trail\s*{[\s\S]*?font-size: var\(--text-xs\);/)
    expect(source).toContain('import Kbd from "@renderer/components/ui/Kbd.svelte";')
    expect(source).toContain('<Kbd variant="inline"')
    expect(source).not.toContain('.menu-hint')
  })

  test('keeps provider usage rows level with the action rows above them', () => {
    // WHY: the Claude Code and Codex rows close the Environment card and are
    // meant to read as menu rows — same glyph column, same size as Files and
    // Terminal directly above. Pinning them to 12px broke that on a large
    // desktop display, where MenuRow steps up to 14px and they did not. The
    // quota windows hanging beneath stay a rung below, as the trail does.
    const source = readRendererSource('project-panel/UsageMeters.svelte')
    expect(source).toContain(
      'class="flex min-h-8 items-center gap-2 px-2 py-[0.3125rem] text-(--solus-text-secondary)"',
    )
    expect(source).toContain('class="flex items-baseline gap-1.5 text-xs"')
  })

  test('lets task rows take the rail rung like every other section row', () => {
    // WHY: the task card pinned its whole subtree to 12px, so on a large
    // desktop display its session and linked rows stayed compact while the Git,
    // Environment and Automations rows beside them stepped up to 14px. Rows
    // inherit the rail's rung; only trailing readings and the group label sit
    // one rung below, exactly as MenuRow's trail does.
    const source = readRendererSource('project-panel/TaskSection.svelte')
    expect(source).toContain(
      `<div class="mb-2 flex flex-col {task.status === 'done' ? 'opacity-[.62]' : ''}">`,
    )
    // The Linked label is a group heading inside the card, so it takes the same
    // shelf rung the card's own header does rather than the row rung it names.
    expect(source).toContain(
      'text-chrome-shelf font-medium text-(--solus-text-tertiary) uppercase',
    )
  })

  test('keeps project section labels one rung below their rows', () => {
    // WHY: a section label names the group; the rows are what you read. A fixed
    // 12px label held that gap on a large display and lost it on a laptop, where
    // the rows step down to 12px themselves and the label can only separate by
    // weight. It now takes the shelf rung, which is a step under the row rung at
    // every width, and the header line declares it once so the title, its detail
    // and the section's own header controls all move together.
    const source = readRendererSource('project-panel/PanelSection.svelte')
    expect(source).toContain('px-1.5 py-0 text-chrome-shelf')
    expect(source).toContain('bg-transparent font-medium')
    expect(source).not.toContain('bg-transparent text-xs font-medium')
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
