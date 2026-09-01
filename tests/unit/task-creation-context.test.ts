import { describe, expect, test } from 'bun:test'
import { taskCreationContextFor } from '@solus/workspace-ui/components/tasks/lib/task-creation-context'

describe('manual task creation context', () => {
  test('groups a task created from a worktree under its base project', () => {
    // WHY: a checkout is session execution context. The task itself belongs to
    // the project and must stay visible from every checkout of that project.
    expect(taskCreationContextFor('/workspace/solus', {
      branch: 'feature/task-context',
      targetBranch: 'main',
      repoRoot: '/workspace/solus',
      worktreePath: '/workspace/solus/.git/solus/worktrees/task-context',
    })).toEqual({
      workingDirectory: '/workspace/solus/.git/solus/worktrees/task-context',
      projectKey: '/workspace/solus',
    })
  })

  test('normalizes a worktree cwd even before git context is available', () => {
    expect(taskCreationContextFor('/workspace/solus/.git/solus/worktrees/task-context', null))
      .toMatchObject({
        workingDirectory: '/workspace/solus/.git/solus/worktrees/task-context',
        projectKey: '/workspace/solus',
      })
  })

  test('rejects an unconfigured workspace', () => {
    expect(taskCreationContextFor('~', null)).toBeNull()
  })
})
