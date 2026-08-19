import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const readComponent = (path: string) =>
  readFileSync(join(import.meta.dir, '../../packages/workspace-ui/src/components', path), 'utf8')

describe('list page context menus', () => {
  test('workspace rows expose their existing item and source-session actions', () => {
    // WHY: opening, pinning, deleting, and returning to the source session are
    // item actions. They must remain available without hunting for hover icons.
    const page = readComponent('workspace/WorkspacePage.svelte')
    const menu = readComponent('workspace/WorkspaceItemContextMenu.svelte')
    expect(page).toContain('onContextMenu={(event) => openItemContextMenu(event, item)}')
    expect(page).toContain('await session.openWorkModal(item.id, undefined, { secondary: true })')
    expect(menu).toContain('Open in split')
    expect(menu).toContain('Open source session in split')
    expect(menu).toContain('Copy item ID')
    expect(menu).toContain('variant="destructive"')
  })

  test('automation rows expose lifecycle and identity actions', () => {
    // WHY: run, pause, star, edit, copy, and delete belong to the automation
    // regardless of whether its compact hover controls are currently visible.
    const page = readComponent('automations/AutomationsPage.svelte')
    const menu = readComponent('automations/AutomationContextMenu.svelte')
    expect(page).toContain('onContextMenu={openAutomationContextMenu}')
    for (const label of [
      'Edit automation',
      'Run now',
      'Pause automation',
      'Copy automation ID',
      'Delete automation',
    ]) expect(menu).toContain(label)
  })

  test('task list rows keep the established task context menu', () => {
    // WHY: a binary done toggle hides the real lifecycle. The list menu must
    // expose every normalized task status and preserve the current selection.
    const page = readComponent('tasks/TasksPage.svelte')
    const menu = readComponent('session/TaskContextMenu.svelte')
    expect(page).toContain('openTaskContextMenu(event, task)')
    expect(page).toContain('<TaskContextMenu')
    expect(page).toContain('onSetStatus={(status) => void onSetStatus(menuTask, status)}')
    expect(menu).toContain('Set status')
    expect(menu).toContain('<ContextMenu.SubContent>')
  })

  test('sessions and tasks both reach Insights from their context menu', () => {
    // WHY: telemetry is only useful where the work is. Both menus scope the
    // page to the thing that was right-clicked — a session by Solus's own id,
    // a task by its id, which is what every one of its turns records.
    const sessionMenu = readComponent('session/SessionContextMenu.svelte')
    const taskMenu = readComponent('session/TaskContextMenu.svelte')
    expect(sessionMenu).toContain('Open in Insights')
    expect(sessionMenu).toContain('session.openInsightsForSession(targetSessionId)')
    expect(taskMenu).toContain('Open in Insights')
    expect(taskMenu).toContain('session.openInsightsForTask(taskId)')
  })

  test('the action row opens the current session in Insights', () => {
    // WHY: the orb is where a session's own actions live; asking what the
    // conversation in front of you cost should not mean retyping its id.
    const orb = readComponent('layout/ActionOrb.svelte')
    expect(orb).toContain('data-orb-action="insights"')
    expect(orb).toContain('session.openInsightsForSession(sessionId)')
  })

  test('pull requests name the browser action as web, not the provider host', () => {
    // WHY: users choose a destination, not an implementation boundary.
    const menu = readComponent('prs/PrContextMenu.svelte')
    expect(menu).toContain('Open in web')
    expect(menu).not.toContain('Open on host')
  })
})
