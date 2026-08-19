import { describe, expect, test } from 'bun:test'
import {
  commentSessionName,
  linkRow,
  linkedTableLinks,
  taskPageCapabilities,
  taskProviderLabel,
} from '@solus/workspace-ui/components/tasks/task-page/lib/task-page'
import {
  commentSyncState,
  heldBackCommentIds,
  taskPublishTarget,
  taskUpstreamState,
} from '@solus/workspace-ui/components/tasks/task-page/lib/task-upstream'
import { taskPrRows } from '@solus/workspace-ui/components/tasks/task-page/lib/task-prs'
import { taskRow } from '@solus/workspace-ui/components/tasks/lib/tasks-list-view'
import { upstreamTaskDetails } from '@solus/workspace-ui/contexts/tasks/upstream-task-details'
import type { Task, TaskComment, TaskExternalLink, TaskLink, TaskSessionLink } from '@solus/contracts/task-types'

// Attempt naming is `sessionDisplayName`, shared by every surface that lists a
// session — see session-utils.test.ts.

describe('task page provider labels', () => {
  test('identifies GitHub as the owner of an upstream task', () => {
    // WHY: the task page action opens the upstream ticket, so its label must
    // name that provider rather than incorrectly describing it as local.
    expect(taskProviderLabel({ providerId: 'github' } as Task)).toBe('GitHub')
  })

  test('identifies a local task as living in Solus', () => {
    expect(taskProviderLabel({ providerId: 'local' } as Task)).toBe('Local task')
  })
})

describe('task comment session attribution', () => {
  const session: TaskSessionLink = {
    sessionId: 'session-123456789',
    sessionTitle: 'Fix comment attribution',
    provider: 'codex',
    lastActivityAt: 1,
    linkedAt: 1,
  }

  test('uses the indexed session title in an agent comment header', () => {
    // WHY: a raw provider id does not tell the user which conversation left a
    // task note when several sessions worked on the same task.
    expect(commentSessionName({ originSessionId: session.sessionId }, [session]))
      .toBe('Fix comment attribution')
  })

  test('keeps attribution useful before the session link is indexed', () => {
    expect(commentSessionName({ originSessionId: '01M0B1F57R0HSH0R0SY2P9AMYX' }, []))
      .toBe('01M0B1F5')
    expect(commentSessionName({}, [session])).toBeNull()
  })
})

describe('task page capabilities', () => {
  test('allows GitHub issue content edits and comments', () => {
    // WHY: the GitHub adapter already implements issue updates and comments;
    // the detail page must not hide those actions merely because it is upstream.
    expect(taskPageCapabilities({ providerId: 'github' } as Task)).toEqual({
      canEditContent: true,
      canEditPlanningFields: false,
      canComment: true,
    })
  })

  test('only enables GitHub planning fields when a Projects board owns them', () => {
    // WHY: due date and priority have no native issue fields off a Projects v2
    // board, so presenting those controls would accept edits GitHub cannot save.
    expect(taskPageCapabilities({
      providerId: 'github',
      canEditPlanningFields: true,
    } as Task).canEditPlanningFields).toBe(true)
  })
})

describe('task list assignee avatars', () => {
  test('uses the provider avatar for an assigned GitHub task', () => {
    // WHY: an issue assigned to the connected GitHub user should show their
    // recognizable profile image on the tasks page, not generated initials.
    const task = {
      id: '31',
      providerId: 'github',
      kind: 'task',
      title: 'GitHub issue',
      body: '',
      status: 'todo',
      url: 'https://github.com/example/solus/issues/31',
      assignee: 'octocat',
      assigneeAvatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4',
      labels: [],
      updatedAt: Date.parse('2026-08-04T12:00:00Z'),
    } satisfies Task

    expect(taskRow(task, 0, Date.parse('2026-08-04T13:00:00Z')).people).toEqual([
      expect.objectContaining({
        id: 'octocat',
        initials: 'OC',
        avatarUrl: task.assigneeAvatarUrl,
      }),
    ])
  })
})

describe('upstream task details', () => {
  test('adapts hydrated GitHub issue comments for the task page', () => {
    // WHY: selecting a GitHub row must use its upstream hydration instead of
    // asking the local SQLite task store for an unrelated numeric id.
    const task: Task = {
      id: '31',
      providerId: 'github',
      projectKey: '/workspace/solus',
      kind: 'task',
      title: 'GitHub issue',
      body: 'Issue body',
      status: 'todo',
      url: 'https://github.com/example/solus/issues/31',
      labels: [],
      updatedAt: Date.parse('2026-08-04T12:00:00Z'),
      raw: {
        comments: [{
          id: 'comment-1',
          author: { login: 'octocat' },
          body: 'A provider comment',
          createdAt: '2026-08-04T12:30:00Z',
        }],
      },
    }

    expect(upstreamTaskDetails(task, [task])).toMatchObject({
      task,
      links: [],
      events: [],
      comments: [{
        id: 'comment-1',
        taskId: '31',
        author: 'octocat',
        source: 'external',
        externalId: 'comment-1',
        body: 'A provider comment',
        createdAt: Date.parse('2026-08-04T12:30:00Z'),
      }],
    })
  })
})

describe('upstream sync state', () => {
  const linkedTask = { id: '01J', providerId: 'local', url: null } as Task
  const link = {
    taskId: '01J',
    provider: 'github',
    externalKey: 'Ashton-Sidhu/solus',
    externalId: '412',
    url: 'https://github.com/Ashton-Sidhu/solus/issues/412',
    dirtyFields: [],
    syncState: 'ok',
    lastSyncedAt: 1_000_000,
    failureCount: 0,
  } satisfies TaskExternalLink

  test('a task with no upstream has none, so the page shows no sync affordance', () => {
    // WHY: a purely local task must not grow a provider row that implies an
    // exchange it has never had.
    expect(taskUpstreamState({ task: linkedTask, comments: [] })).toBeNull()
  })

  test('counts dirty fields and queued comments as writes the ticket has not taken', () => {
    // WHY: "Synced" while a comment is still queued is the lie this page exists
    // to prevent — the count is the user's only sign that we are holding writes.
    const state = taskUpstreamState({
      task: linkedTask,
      externalLink: { ...link, dirtyFields: ['title', 'status'] },
      comments: [
        { id: 'c1', taskId: '01J', source: 'local', body: 'a', createdAt: 1, syncPending: true },
        { id: 'c2', taskId: '01J', source: 'local', body: 'b', createdAt: 2 },
      ],
      now: 1_000_000,
    })
    expect(state?.pendingCount).toBe(3)
    expect(state?.tone).toBe('pending')
    expect(state?.label).toBe('3 to push')
    expect(state?.pendingLabel).toBe('3 changes to push')
  })

  test('reads as synced, with the ticket reference, when nothing is held back', () => {
    const state = taskUpstreamState({ task: linkedTask, externalLink: link, comments: [], now: 1_000_000 })
    expect(state?.label).toBe('Synced')
    expect(state?.tone).toBe('ok')
    expect(state?.ref).toBe('#412')
    expect(state?.canSync).toBe(true)
  })

  test('an auth failure asks for a reconnect rather than reporting a sync', () => {
    // WHY: an expired token is not a transient sync error; retrying it silently
    // leaves the page quietly stale forever.
    const state = taskUpstreamState({
      task: linkedTask,
      externalLink: { ...link, syncState: 'auth_error', syncError: 'Bad credentials' },
      comments: [],
      now: 1_000_000,
    })
    expect(state?.label).toBe('Reconnect GitHub')
    expect(state?.tone).toBe('error')
  })

  test('a provider-owned ticket is read live, so it offers no push', () => {
    // WHY: every read of a GitHub-owned task goes to GitHub, so there is no
    // local backlog — offering "Sync now" would overstate what happens.
    const state = taskUpstreamState({
      task: { id: '412', providerId: 'github', url: 'https://github.com/o/r/issues/412' } as Task,
      comments: [],
    })
    expect(state?.canSync).toBe(false)
    expect(state?.ref).toBe('#412')
    expect(state?.pendingCount).toBe(0)
  })
})

describe('linked pull requests', () => {
  const prLink = (targetKey: string, title: string): TaskLink => ({
    taskId: '01J',
    kind: 'pr',
    targetScope: '/repo',
    targetKey,
    title,
    createdBy: 'user',
    linkedAt: 1,
  })

  test('PRs leave the Linked table, because their own section owns them', () => {
    // WHY: two places listing the same PR would disagree the moment one of them
    // learns the PR merged.
    const links = [prLink('418', 'Unify picker index'), {
      taskId: '01J',
      kind: 'work',
      targetScope: '',
      targetKey: 'w1',
      title: 'RFC',
      createdBy: 'user',
      linkedAt: 2,
    } satisfies TaskLink]
    expect(linkedTableLinks(links).map((link) => link.kind)).toEqual(['work'])
  })

  test('rows carry live state when a PR is known, and none when it is not', () => {
    // WHY: an unread PR must render without a state rather than defaulting to
    // "Open" — a merged PR shown as open is worse than no badge at all.
    const rows = taskPrRows(
      [prLink('418', 'Unify picker index'), prLink('421', 'Delete file picker')],
      (number) => (number === 418 ? { state: 'merged', draft: false } : null),
    )
    expect(rows.map((row) => row.ref)).toEqual(['#421', '#418'])
    expect(rows[1].state).toEqual({ state: 'merged', draft: false })
    expect(rows[0].state).toBeNull()
  })

  test('rows omit a PR number that already has its own column', () => {
    // WHY: PR discovery can persist a title with its reference; rendering it
    // beside the reference column must not repeat the same identity.
    const [row] = taskPrRows([prLink('418', '#418 Unify picker index')], () => null)
    expect(row).toMatchObject({ ref: '#418', title: 'Unify picker index' })
  })

  test('the project rail does not repeat a PR number captured in its title', () => {
    // WHY: the rail gives the number its own column, so keeping the captured
    // prefix would render the same PR identity twice on one line.
    expect(linkRow(prLink('418', '#418 Unify picker index'))).toMatchObject({
      ref: '#418',
      label: 'Unify picker index',
    })
    expect(linkRow(prLink('418', '#418'))).toMatchObject({
      ref: '#418',
      label: '',
    })
  })
})

describe('comment publishing', () => {
  const comment = (over: Partial<TaskComment>): TaskComment => ({
    id: 'c1',
    taskId: '01J',
    source: 'local',
    body: 'note',
    createdAt: 1,
    ...over,
  })

  test('a task with no ticket asks nothing of its comments', () => {
    // WHY: a publish button on a task with nowhere to publish to is a dead end.
    expect(commentSyncState(comment({}), false)).toBe('none')
  })

  test('separates posted, queued and held-back comments', () => {
    // WHY: these three drive three different affordances — a check, a spinner
    // and a Publish button — and confusing them either hides the action or
    // offers to post the same comment twice.
    expect(commentSyncState(comment({ source: 'external' }), true)).toBe('published')
    expect(commentSyncState(comment({ externalId: 'gh-1' }), true)).toBe('published')
    expect(commentSyncState(comment({ syncPending: true }), true)).toBe('queued')
    expect(commentSyncState(comment({}), true)).toBe('held')
  })

  test('Publish all acts only on the comments that are actually held back', () => {
    const ids = heldBackCommentIds(
      [
        comment({ id: 'a' }),
        comment({ id: 'b', syncPending: true }),
        comment({ id: 'c', externalId: 'gh-2' }),
        comment({ id: 'd' }),
      ],
      true,
    )
    expect(ids).toEqual(['a', 'd'])
  })
})

describe('publishing a task that has no ticket', () => {
  const localTask = { id: '01J', providerId: 'local', url: null } as Task
  const status = { provider: 'github', ok: true, repo: { owner: 'Ashton-Sidhu', repo: 'solus' } } as const

  test('offers the project provider, naming the repo the issue would land in', () => {
    // WHY: publishing writes to someone's repo. The page names which one before
    // the user commits to it.
    expect(taskPublishTarget({ task: localTask, upstream: null, status })).toEqual({
      provider: 'GitHub',
      repo: 'Ashton-Sidhu/solus',
    })
  })

  test('offers nothing when the provider cannot be reached', () => {
    // WHY: a publish that is going to fail should not be offered as if it works.
    expect(taskPublishTarget({ task: localTask, upstream: null, status: { ...status, ok: false } }))
      .toBeNull()
  })

  test('offers nothing for a project with no provider, or a task already filed', () => {
    expect(taskPublishTarget({ task: localTask, upstream: null, status: { provider: 'local', ok: true } }))
      .toBeNull()
    const upstream = taskUpstreamState({
      task: { id: '412', providerId: 'github', url: null } as Task,
      comments: [],
    })
    expect(taskPublishTarget({ task: localTask, upstream, status })).toBeNull()
  })
})
