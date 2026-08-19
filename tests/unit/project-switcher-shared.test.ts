import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const root = join(import.meta.dir, '../..')
const source = (path: string) => readFileSync(join(root, path), 'utf8')

/** Every page-level surface that lets a user change what project it is reading. */
const SCOPED_PAGES = [
  'src/renderer/components/tasks/TasksPage.svelte',
  'src/renderer/components/prs/PrsPage.svelte',
  'src/renderer/components/automations/AutomationsPage.svelte',
  'src/renderer/components/workspace/WorkspacePage.svelte',
]

describe('shared project switcher', () => {
  test('every scoped page states its scope with the one switcher', () => {
    // WHY: a person switching project must not have to relearn the control on
    // each page. Tasks and Pull requests reach it through ListPage; Automations
    // does too; the Workspace mounts it directly. A page that grows its own
    // picker again is the regression this guards.
    for (const path of SCOPED_PAGES) {
      const page = source(path)
      const usesShell = /<ListPage[\s\S]*?projects=\{/.test(page)
      const usesSwitcher = page.includes('<ListProjectSwitcher')
      expect(usesShell || usesSwitcher).toBe(true)
    }
  })

  test('no page keeps a private project picker beside the shared one', () => {
    // WHY: the bespoke Workspace and Automations pickers drifted apart in row
    // grammar, trigger shape and type size. They are gone; nothing may import
    // a picker that is not the shared one.
    for (const path of [
      'src/renderer/components/workspace/WorkspaceProjectSwitcher.svelte',
      'src/renderer/components/automations/AutomationProjectFilter.svelte',
    ]) {
      expect(existsSync(join(root, path))).toBe(false)
    }
  })

  test('the switcher takes the responsive chrome rung, not a fixed size', () => {
    // WHY: the trigger is workspace chrome, so it shrinks with every other
    // control on a laptop display instead of pinning itself to one pixel size.
    const switcher = source(
      'src/renderer/components/ui/list-page/ListProjectSwitcher.svelte',
    )
    expect(switcher).toContain('text-workspace-chrome')
    expect(switcher).not.toContain('compactText')
  })

  test('each page says what its own scope change costs', () => {
    // WHY: the pages do not discard the same state — the Workspace and
    // Automations keep their facets, the list pages do not. One shared control
    // with a per-page note beats four controls that each guess.
    expect(source('src/renderer/components/workspace/WorkspacePage.svelte')).toContain(
      'footerNote="Switching keeps facets, clears search"',
    )
    expect(
      source('src/renderer/components/automations/AutomationsPage.svelte'),
    ).toContain('projectSwitchNote="Switching keeps filters, clears search"')
  })
})
