import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { linkedPrNavigationTarget } from '@solus/workspace-ui/components/tasks/task-page/lib/linked-pr-navigation'

const taskPage = readFileSync(
  resolve(import.meta.dir, '../../packages/workspace-ui/src/components/tasks/task-page/TaskPage.svelte'),
  'utf8',
)

describe('linked task PR navigation', () => {
  it('keeps the task project path on the host that owns the task', () => {
    // WHY: a task can be viewed from an attempt running on another host. The
    // task project path has meaning only on its owning host.
    expect(linkedPrNavigationTarget({
      taskServerId: 'project-host',
      taskProjectDirectory: '/Users/sidhu/solus',
      linkProjectDirectory: '/tmp/deleted-pr-worktree',
    })).toEqual({
      serverId: 'project-host',
      projectDirectory: '/Users/sidhu/solus',
    })
  })

  it('falls back to the link scope for older task records', () => {
    expect(linkedPrNavigationTarget({
      taskServerId: null,
      taskProjectDirectory: null,
      linkProjectDirectory: '/repos/solus',
    })).toEqual({ projectDirectory: '/repos/solus' })
  })

  it('opens the linked PR across from the task instead of replacing it', () => {
    // WHY: the task is the context for its linked PR. A click must keep the
    // task visible and put the review in the other pane, even if focus moved.
    expect(taskPage).toContain('session.router.targetAcrossFrom(paneId)')
    expect(taskPage).toContain(': "aside"')
  })
})
