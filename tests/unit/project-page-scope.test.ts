import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repo = join(import.meta.dir, '../..')
const read = (path: string) => readFileSync(join(repo, path), 'utf8')

const desktop = read('packages/workspace-ui/src/App.svelte')
const web = read('apps/client/src/App.svelte')
const workspace = read(
  'packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts',
)

describe('project opening owns an explicit target', () => {
  test('desktop and web send Cmd O to the visible source, not a hidden chat', () => {
    for (const shell of [desktop, web]) {
      expect(shell).toContain('requesterId:')
      expect(shell).toContain('focusedSourceId')
      expect(shell).toContain('scopeOpenProjectPage')
      expect(shell).toContain('projectsStore.recordProject')
    }
  })

  test('all four project pages read the shared host-qualified scope', () => {
    for (const path of [
      'packages/workspace-ui/src/components/tasks/TasksPage.svelte',
      'packages/workspace-ui/src/components/prs/PrsPage.svelte',
      'packages/workspace-ui/src/components/workspace/WorkspacePage.svelte',
      'packages/workspace-ui/src/components/automations/AutomationsPage.svelte',
    ]) {
      expect(read(path)).toContain('session.projectPageScope')
    }
  })

  test('page navigation captures a composer scope once and preserves page-to-page scope', () => {
    expect(workspace).toContain('this.prepareProjectPageScope()')
    expect(workspace).toContain('if (this.hasProjectPageOpen) return')
    expect(workspace).toContain('project: { serverId: run.taskServerId, projectRoot }')
  })
})
