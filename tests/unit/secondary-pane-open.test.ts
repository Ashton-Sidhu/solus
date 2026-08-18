import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const rendererRoot = join(import.meta.dir, '../../src/renderer/components')

function readRendererFile(path: string): string {
  return readFileSync(join(rendererRoot, path), 'utf8')
}

describe('secondary pane open action', () => {
  test('every routed pane chrome can open its secondary content as a page', () => {
    // WHY: maximize and close are not substitutes for navigation. Every route
    // shown beside the leading pane must give the user a direct way to make
    // that content the page, including temporary overlay routes.
    const routedPaneHosts = [
      'automations/AutomationPane.svelte',
      'conversation/SubagentHostPane.svelte',
      'files/FileEditorHostPane.svelte',
      'files/FilesTreePane.svelte',
      'plan/PlanPane.svelte',
      'pr-review/PrDiffPane.svelte',
      'review/ReviewPane.svelte',
      'work/WorkPane.svelte',
    ]

    for (const path of routedPaneHosts) {
      const source = readRendererFile(path)
      expect(source, path).toContain('<PaneChrome')
      expect(source, path).toContain('onOpenInSplit=')
    }
  })

  test('conversation and draft panes expose the same action in their shared header', () => {
    const conversation = readRendererFile('conversation/ConversationPane.svelte')
    const draft = readRendererFile('session-draft/SessionDraftPane.svelte')
    const breadcrumb = readRendererFile('conversation/SessionBreadcrumb.svelte')

    expect(conversation).toContain('onOpenAsPage=')
    expect(draft).toContain('onOpenAsPage=')
    expect(breadcrumb).toContain('aria-label="Open as page"')
  })

  test('the tasks list and task detail expose the action in their page headers', () => {
    const tasks = readRendererFile('tasks/TasksPage.svelte')
    const task = readRendererFile('tasks/task-page/TaskPage.svelte')
    const listPage = readRendererFile('ui/list-page/ListPage.svelte')
    const taskChrome = readRendererFile('tasks/task-page/TaskChromeBar.svelte')

    expect(tasks).toContain('onOpenAsPage={!pane.isLeading ? pane.moveAcross : undefined}')
    expect(task).toContain('onOpenAsPage={!pane.isLeading ? pane.moveAcross : undefined}')
    expect(listPage).toContain('aria-label="Open as page"')
    expect(taskChrome).toContain('aria-label="Open as page"')
  })
})
