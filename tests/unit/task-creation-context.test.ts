import { describe, expect, test } from 'bun:test'
import { taskCreationContextFor } from '../../src/renderer/components/tasks/lib/task-creation-context'

describe('manual task creation context', () => {
  test('captures the active worktree while grouping the task under its base project', () => {
    // WHY: opening the Tasks page or command palette must not flatten a task
    // created from a worktree back onto the base checkout.
    expect(taskCreationContextFor('/workspace/solus', {
      branch: 'feature/task-context',
      targetBranch: 'main',
      repoRoot: '/workspace/solus',
      worktreePath: '/workspace/solus/.solus-worktrees/task-context',
    })).toEqual({
      workingDirectory: '/workspace/solus/.solus-worktrees/task-context',
      projectKey: '/workspace/solus',
      branch: 'feature/task-context',
      worktreeKey: '/workspace/solus::feature/task-context (worktree)',
    })
  })

  test('normalizes a worktree cwd even before git context is available', () => {
    expect(taskCreationContextFor('/workspace/solus/.solus-worktrees/task-context', null))
      .toMatchObject({
        workingDirectory: '/workspace/solus/.solus-worktrees/task-context',
        projectKey: '/workspace/solus',
        branch: null,
        worktreeKey: '/workspace/solus::no branch',
      })
  })

  test('rejects an unconfigured workspace', () => {
    expect(taskCreationContextFor('~', null)).toBeNull()
  })
})
