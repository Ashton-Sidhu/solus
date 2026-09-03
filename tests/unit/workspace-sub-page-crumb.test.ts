import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * A document, diagram, artifact, or plan is a row on the Workspace page, the
 * way a task is a row on Tasks and a pull request a row on Pull requests. Those
 * sub pages each name the page they came from and go back to it; the Workspace
 * sub pages did not, so a reader inside a work had no way back except closing.
 *
 * Asserted against the markup because the way back is a crumb the shell either
 * renders or forgets, and forgetting it produces no error — which is how it
 * was missing in the first place.
 */
const components = join(import.meta.dir, '../../packages/workspace-ui/src/components')

function source(relative: string): string {
  return readFileSync(join(components, relative), 'utf8')
}

const WORKSPACE_CRUMB = '<ParentPageCrumb page="folio" onOpen={onOpenWorkspace} />'

describe('every Workspace sub page shell leads its header with the Workspace crumb', () => {
  test.each([
    'document-shell/DocumentShell.svelte',
    'diagram/DiagramShell.svelte',
    'artifact/ArtifactShell.svelte',
  ])('%s', (shell) => {
    expect(source(shell)).toContain(WORKSPACE_CRUMB)
  })
})

describe('every host hands its shell the way back', () => {
  test('the work pane, for all three work shells', () => {
    // WHY: the shells only render the crumb when a host supplies the command,
    // so a host that forgets it ships a work with no way back and no error.
    const pane = source('work/WorkPane.svelte')
    expect(pane.match(/onOpenWorkspace=\{openWorkspacePage\}/g)).toHaveLength(3)
    expect(pane).toContain('session.openFolio()')
  })

  test('the plan modal, through the document shell', () => {
    const plan = source('plan/PlanModal.svelte')
    expect(plan).toContain('onOpenWorkspace={openWorkspacePage}')
    expect(plan).toContain('session.openFolio()')
  })

  test('pill mode, for the document and the diagram it renders inline', () => {
    const pill = source('layout/PillLayout.svelte')
    expect(pill.match(/onOpenWorkspace=\{\(\) => \{ session\.closeWorkModal\(\); session\.openFolio\(\) \}\}/g)).toHaveLength(2)
  })
})

describe('every record page heads itself with the one shared sub page band', () => {
  // WHY: a task, a pull request, an Insights turn, and an automation are the
  // same kind of destination. Four hand-built bands drifted into four sets of
  // behaviour; one component is what keeps the way back, the stepper, and the
  // pane controls in the same place on each.
  test.each([
    ['tasks', 'tasks/task-page/TaskChromeBar.svelte'],
    ['prs', 'pr-review/PrDetailChrome.svelte'],
    ['insights', 'insights/TurnDetailPanel.svelte'],
    ['automations', 'automations/AutomationBuilder.svelte'],
  ])('%s', (page, file) => {
    const markup = source(file)
    expect(markup).toContain('<SubPageCrumbLine')
    expect(markup).toContain(`page="${page}"`)
  })

  test('the Insights page yields its own crumb line to a full-screen turn', () => {
    // WHY: two bands on the same edge showed through each other as a doubled
    // "Insights"; the turn's band carries the whole path, so the page's goes.
    expect(source('insights/InsightsPage.svelte')).toContain('{#if !panelFullScreen}\n  <header')
  })
})

describe('the crumb names the page by its one shared spec', () => {
  test('reads the label from page-nav rather than restating it', () => {
    // WHY: the session sidebar, the page crumb menu, and this crumb must agree
    // on what the page is called; a literal "Workspace" here would drift.
    const crumb = source('ui/list-page/ParentPageCrumb.svelte')
    expect(crumb).toContain('navPageSpec(page)')
    expect(crumb).not.toMatch(/>\s*Workspace\s*</)
  })
})
