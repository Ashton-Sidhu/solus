import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const root = join(import.meta.dir, '../..')
const source = (path: string) => readFileSync(join(root, path), 'utf8')

describe('workspace and automation laptop scaling', () => {
  test('uses the shared responsive chrome rung across workspace controls and rows', () => {
    // WHY: workspace controls and row titles must stay on the same compact
    // laptop rung as Tasks instead of remaining fixed at the 14px desktop size.
    //
    // The page declares the rung; its controls inherit it. Those are two ways
    // of saying the same thing, and only the first belongs on a surface: a
    // control that names its own size cannot follow the surface that hosts it,
    // which is how ListProjectSwitcher ended up a rung above the Tasks and
    // Pull-requests lists it sits in — those pages never had the inline
    // override Automations did.
    for (const path of [
      'src/renderer/components/workspace/WorkspacePage.svelte',
      'src/renderer/components/workspace/WorkspaceRow.svelte',
    ]) {
      expect(source(path)).toContain('text-workspace-chrome')
    }
    // The action cluster and the facet row are the compact rung, by name.
    expect(source('src/renderer/components/workspace/WorkspacePage.svelte'))
      .toContain('text-chrome-dense')
    // Shared controls carry no size of their own, so they follow their host.
    for (const path of [
      'src/renderer/components/ui/list-page/ListProjectSwitcher.svelte',
      'src/renderer/components/workspace/WorkspaceSearchField.svelte',
    ]) {
      expect(source(path)).not.toContain('text-workspace-chrome')
    }
  })

  test('puts the workspace header controls on the compact list-page rung', () => {
    // WHY: the Workspace head is the same action cluster Tasks and Automations
    // carry, so its scope switcher, New button and filters must read one step
    // below the ledger rather than at the ledger's own size. Coarse-pointer
    // clients stay on the touch-readable rung.
    const page = source('src/renderer/components/workspace/WorkspacePage.svelte')
    // Both header bands — the action cluster and the filter row — and only
    // those: the ledger keeps the responsive rung its rows are read at, so the
    // compact rung must not sit on the page root.
    //
    // This used to count copies of an inline `--text-workspace-chrome` value.
    // The bands are the same two, and the density is the same 12/14 pair; they
    // now say so by naming `text-chrome-dense`, a rung defined once in
    // index.css, instead of each restating the laptop and coarse-pointer
    // boundary. A page may pick a rung; it may not redefine one.
    expect(page.split('text-chrome-dense').length - 1).toBe(2)
    expect(page).not.toContain('[--text-workspace-chrome:')
    expect(page).toContain(
      'class="workspace-root relative flex min-h-0 flex-1 flex-col bg-background text-workspace-chrome text-foreground"',
    )
  })

  test('tightens the page heads on laptop displays', () => {
    // WHY: a laptop screen cannot spend the desktop top band and the desktop
    // control heights before the first row. Geometry follows the laptop class;
    // type keeps coming from the shared rung.
    const listPage = source('src/renderer/components/ui/list-page/ListPage.svelte')
    expect(listPage).toContain('pt-[42px] [.is-laptop-display_&]:pt-8')
    expect(listPage).toContain('h-[30px] [.is-laptop-display_&]:h-[26px]')

    const page = source('src/renderer/components/workspace/WorkspacePage.svelte')
    expect(page).toContain('pt-[42px] pb-3.5 [.is-laptop-display_&]:pt-8')
    expect(page).toContain('h-[30px] [.is-laptop-display_&]:h-[26px]')
    // Search field, facet menus and toggle chips share one row, so they share
    // one height at both display sizes.
    expect(page).toContain('h-7 [.is-laptop-display_&]:h-6.5')
    expect(
      source('src/renderer/components/workspace/WorkspaceSearchField.svelte'),
    ).toContain('h-7 [.is-laptop-display_&]:h-6.5')
  })

  test('opts the automation list into the compact list-page controls', () => {
    // WHY: Automations shares the list shell with Tasks and Pull Requests, so
    // its search, sort, and primary action must use the same laptop density.
    // The density is unchanged; how it is asked for is. The page used to write
    // `--text-workspace-chrome`'s value inline, which meant restating the
    // laptop and coarse-pointer boundary here — one of six hand-maintained
    // copies that could each drift. `text-chrome-dense` is that same 12/14 pair
    // as a named rung in index.css, so the page picks a rung instead of
    // redefining what one means.
    const page = source(
      'src/renderer/components/automations/AutomationsPage.svelte',
    )
    expect(page).toContain('text-chrome-dense')
    expect(page).not.toContain('[--text-workspace-chrome:')
    expect(page).toMatch(/<ListFilterBar[\s\S]*?compactText/)
    expect(page).toContain('class="h-7 gap-1.5 rounded-lg px-2.5 text-xs')
    expect(page).toMatch(/<ListPage[\s\S]*?compactPrimaryActionText/)
  })

  test('keeps the detail view readable wherever it is hosted', () => {
    // WHY: pill mode renders the builder inside the compact list page and
    // editor mode renders it in a pane. One automation reads the same size in
    // both, instead of shrinking with its host.
    //
    // That used to need a pin — the builder had to overwrite
    // `--text-workspace-chrome` back to 14px, because the compact list page
    // hosting it had overwritten the same variable to 12px and the builder
    // inherited the change. Neither page redefines the variable now; both pick
    // a rung by class. So naming the rung is enough to be independent of the
    // host, and the pin is gone. The builder does still follow the *display* —
    // 12px on a laptop, like the rest of chrome — which the pin used to prevent.
    const builder = source(
      'src/renderer/components/automations/AutomationBuilder.svelte',
    )
    expect(builder).toContain('text-workspace-chrome')
    expect(builder).not.toContain('[--text-workspace-chrome:')
  })

  test('sets every automation label and machine fact on one metadata rung', () => {
    // WHY: eyebrows, save status, run stamps and stat labels are all secondary
    // to the values they describe, so they share one size a step below the
    // surface rung rather than each picking their own.
    expect(source('src/renderer/components/automations/lib/rail-styles.ts')).toContain(
      "export const EYEBROW = 'text-xs font-normal text-muted-foreground uppercase'",
    )
    const builder = source(
      'src/renderer/components/automations/AutomationBuilder.svelte',
    )
    expect(builder).toContain('const STAT_VALUE = "text-workspace-chrome font-medium"')
    expect(builder).toContain('gap-[0.3125rem] text-xs whitespace-nowrap')
    expect(builder).not.toContain('STAT_LABEL')
    const history = source(
      'src/renderer/components/automations/AutomationRunHistory.svelte',
    )
    expect(history).toContain('shrink-0 text-xs tabular-nums text-muted-foreground')
  })

  test('keeps automation details compact without changing touch sizing', () => {
    // WHY: the detail view needs less spacing on laptop displays, while its
    // coarse-pointer sizing continues to come from the shared responsive rung.
    const builder = source(
      'src/renderer/components/automations/AutomationBuilder.svelte',
    )
    expect(builder).toContain('[.is-laptop-display_&]:gap-10')
    expect(builder).toContain('[.is-laptop-display_&]:px-9')
    expect(builder).toContain('text-workspace-chrome')
    expect(builder).toContain('pointer-coarse:px-5')
    expect(builder).toContain('pointer-coarse:min-h-10')
  })

  test('keeps the automation create field compact on every desktop size', () => {
    // WHY: the quick-create field must not grow back to the large desktop
    // metric on wide monitors, while touch clients keep the larger hit area.
    const launchpad = source(
      'src/renderer/components/automations/AutomationLaunchpad.svelte',
    )
    expect(launchpad).toContain('class="mt-2 flex h-10')
    expect(launchpad).toContain('class="flex h-[26px]')
    expect(launchpad).toContain('pointer-coarse:h-[30px]')
  })
})
