import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const rendererRoot = join(import.meta.dir, '../../src/renderer/components')

function readRendererFile(path: string): string {
  return readFileSync(join(rendererRoot, path), 'utf8')
}

const paneSource = readRendererFile('ui/Pane.svelte')

describe('loading state while a surface moves between panes', () => {
  test('every workspace page the swap control can move draws a skeleton, not a text label', () => {
    // WHY: moving a surface across remounts it — a new pane id for the outward
    // move, a changed base for the return — so the lazy import is re-awaited on
    // every swap. A centred "Loading…" is what the user reads on each one, and
    // it collapses the page's geometry so the real surface then settles into
    // place. Each route the move can reach must name its own skeleton here.
    const routeSkeletons: [route: string, skeleton: string][] = [
      ['prs', 'PrsPageSkeleton'],
      ['prReview', 'PrReviewSkeleton'],
      ['tasks', 'TasksPageSkeleton'],
      ['task', 'TaskPageSkeleton'],
      ['automations', 'AutomationsPageSkeleton'],
      ['automation', 'AutomationBuilderSkeleton'],
      ['insights', 'InsightsPageSkeleton'],
    ]

    for (const [route, skeleton] of routeSkeletons) {
      expect(paneSource, route).toMatch(
        new RegExp(`ref\\.name === "${route}"\\s*}\\s*<${skeleton} />`),
      )
    }
  })

  test('the pill shell draws the same skeletons as the pane outlet', () => {
    // WHY: pill mode reaches the same pages through its own lazy imports. A
    // skeleton wired only into the pane outlet leaves the other shell showing
    // the label this rule exists to remove.
    const pill = readRendererFile('layout/PillLayout.svelte')

    for (const [module, skeleton] of [
      ['../prs/PrsPage.svelte', 'PrsPageSkeleton'],
      ['../tasks/TasksPage.svelte', 'TasksPageSkeleton'],
      ['../automations/AutomationsPage.svelte', 'AutomationsPageSkeleton'],
    ]) {
      expect(pill, module).toMatch(
        new RegExp(`{#await import\\("${module.replace(/[./]/g, '\\$&')}"\\)}\\s*<${skeleton} />`),
      )
    }
  })

  test('the automation builder covers its store wait as well as its module wait', () => {
    // WHY: the builder has two gates before it can draw — the store fetching the
    // named automation and its own lazy module. The store wait used to render
    // nothing at all, including no PaneChrome, so a pane moved across mid-load
    // showed an empty surface with no way out of it.
    const automationPane = readRendererFile('automations/AutomationPane.svelte')

    expect(automationPane).toMatch(
      /params\.automationId !== null && !automation}\s*<AutomationBuilderSkeleton \/>/,
    )
    expect(automationPane).toMatch(
      /{#await import\("\.\/AutomationBuilder\.svelte"\)}\s*<AutomationBuilderSkeleton \/>/,
    )
    // The chrome sits outside the content branch, so every state can be closed.
    expect(automationPane).toMatch(/{\/if}\s*<!--[\s\S]*?-->\s*<PaneChrome/)
  })

  test("the insights turn detail draws a skeleton when its trace is re-read", () => {
    // WHY: the open turn lives in the route params, so it survives the move and
    // re-fetches its spans in the new pane.
    const turnDetail = readRendererFile('insights/TurnDetailPanel.svelte')
    expect(turnDetail).toMatch(/{#if loading && !view}\s*<TurnDetailSkeleton \/>/)
  })
})
