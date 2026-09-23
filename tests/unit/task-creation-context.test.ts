import { describe, expect, test } from 'bun:test'
import { taskCreationContextFor } from '@solus/workspace-ui/components/tasks/lib/task-creation-context'

describe('manual task creation context', () => {
  test('groups a task created from a worktree under its base project', () => {
    // WHY: a checkout is session execution context. The task itself belongs to
    // the project and must stay visible from every checkout of that project.
    expect(taskCreationContextFor('host-a', '/workspace/solus', {
      branch: 'feature/task-context',
      targetBranch: 'main',
      repoRoot: '/workspace/solus',
      worktreePath: '/workspace/solus/.git/solus/worktrees/task-context',
    })).toEqual({
      serverId: 'host-a',
      workingDirectory: '/workspace/solus/.git/solus/worktrees/task-context',
      projectKey: '/workspace/solus',
    })
  })

  test('normalizes a worktree cwd even before git context is available', () => {
    expect(taskCreationContextFor('host-a', '/workspace/solus/.git/solus/worktrees/task-context', null))
      .toMatchObject({
        workingDirectory: '/workspace/solus/.git/solus/worktrees/task-context',
        projectKey: '/workspace/solus',
      })
  })

  test('keeps the host that owns the project with the path', () => {
    // WHY: the same path can exist on two hosts. The context is what the
    // composer files the task through, so it must name the host itself rather
    // than leave a store to guess one from the path.
    expect(taskCreationContextFor('host-b', '/workspace/app', null)?.serverId).toBe('host-b')
  })

  test('rejects an unconfigured workspace', () => {
    expect(taskCreationContextFor('host-a', '~', null)).toBeNull()
  })
})
