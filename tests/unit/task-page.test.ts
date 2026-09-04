import { describe, expect, test } from 'bun:test'
import {
  commentSessionName,
  eventLine,
  linkGroups,
  linkRow,
  linkedTableLinks,
  linkedWorkProvider,
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
import type { Task, TaskComment, TaskEvent, TaskExternalLink, TaskLink, TaskSessionLink } from '@solus/contracts/task-types'
import type { Work } from '@solus/contracts/types'

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
    startedAt: 1,
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

describe('task label activity', () => {
  const event = {
    id: 'event-1',
    taskId: 'task-1',
    kind: 'labels_changed',
    actor: 'user',
    createdAt: 1,
  } satisfies TaskEvent

  test('names a label that was added or removed', () => {
    // WHY: the activity feed is an audit trail. "Changed labels" does not say
    // what changed and forces the reader to reconstruct old task state.
    expect(eventLine({ ...event, from: '[]', to: '["bug"]' }).text)
      .toBe('You added label “bug”')
    expect(eventLine({ ...event, from: '["bug"]', to: '[]' }).text)
      .toBe('You removed label “bug”')
  })

  test('names both sides of a replacement and handles several labels', () => {
    expect(eventLine({
      ...event,
      from: '["old"]',
      to: '["design","ready"]',
    }).text).toBe('You added labels “design” and “ready” and removed label “old”')
  })

  test('a row without a readable snapshot still reads, rather than taking the page down', () => {
    // WHY: this runs on a render path. One malformed or snapshot-less event
    // must not throw out of the derived that draws the whole activity list.
    expect(eventLine({ ...event, from: null, to: '["bug"]' }).text).toBe('You changed the labels')
    expect(eventLine({ ...event, from: '{', to: '["bug"]' }).text).toBe('You changed the labels')
    expect(eventLine({ ...event, from: '[1]', to: '["bug"]' }).text).toBe('You changed the labels')
    expect(eventLine({ ...event, from: '["bug"]', to: '["bug"]' }).text).toBe('You changed the labels')
  })
})

describe('task page capabilities', () => {
  test('allows GitHub issue content edits and comments', () => {
    // WHY: the GitHub adapter already implements issue updates and comments;
    // the detail page must not hide those actions merely because it is upstream.
    expect(taskPageCapabilities({ providerId: 'github' } as Task)).toEqual({
      canEditContent: false,
      canEditPlanningFields: false,
      canEditPriority: false,
      canEditLabels: false,
      canEditAssignee: false,
      editableStatuses: [],
      canComment: true,
    })
  })

  test('uses provider status capabilities for an unstored ticket', () => {
    // WHY: Jira and GitHub distinguish different statuses and writable fields;
    // the page must not offer a write the active adapter cannot take.
    expect(taskPageCapabilities({ providerId: 'jira' } as Task, {
      provider: 'jira', ok: true, reason: 'ok', message: '',
      writableFields: ['title', 'body', 'status', 'labels', 'priority'],
      statuses: ['todo', 'in_progress', 'in_review', 'done'],
    })).toEqual({
      canEditContent: true,
      canEditPlanningFields: false,
      canEditPriority: true,
      canEditLabels: true,
      canEditAssignee: false,
      editableStatuses: ['todo', 'in_progress', 'in_review', 'done'],
      canComment: true,
    })
  })

  test('offers assignment when the provider can list and write assignees', () => {
    expect(taskPageCapabilities({ providerId: 'github' } as Task, {
      provider: 'github', ok: true, reason: 'ok', message: '',
      writableFields: ['title', 'body', 'status', 'labels', 'assignee'],
      statuses: ['todo', 'in_progress', 'done'],
    }).canEditAssignee).toBe(true)
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
    expect(rows.map((row) => row.ref)).toEqual(['#418', '#421'])
    expect(rows[0].state).toEqual({ state: 'merged', draft: false })
    expect(rows[1].state).toBeNull()
  })

  test('orders linked PRs by link time instead of PR number', () => {
    // WHY: the sidebar snapshot and task page must agree on the newest durable
    // edge when several repositories can reuse the same range of PR numbers.
    const older = { ...prLink('900', 'Older high number'), linkedAt: 1 }
    const newer = { ...prLink('12', 'Newer low number'), linkedAt: 2 }
    expect(taskPrRows([older, newer], () => null).map((row) => row.ref))
      .toEqual(['#12', '#900'])
  })

  test('rows omit a PR number that already has its own column', () => {
    // WHY: PR discovery can persist a title with its reference; rendering it
    // beside the reference column must not repeat the same identity.
    const [row] = taskPrRows([prLink('418', '#418 Unify picker index')], () => null)
    expect(row).toMatchObject({ ref: '#418', title: 'Unify picker index' })
  })

  test('an artifact work is its own kind of row, told apart by the live work type', () => {
    // WHY: a task link to an artifact is a `work` link like a document's, and
    // the read joins the work's type into `liveStatus`. The row must say
    // "Artifact" and offer the in-place render, without the type leaking into
    // the status column as a bare word.
    const artifact: TaskLink = {
      taskId: 't1',
      kind: 'work',
      targetScope: '',
      targetKey: 'w-art',
      title: 'Latency report',
      liveTitle: 'Latency report',
      liveStatus: 'artifact',
      createdBy: 'agent',
      linkedAt: 1,
    }
    expect(linkRow(artifact)).toMatchObject({ kindLabel: 'Artifact', isArtifact: true, meta: '' })
    expect(linkRow({ ...artifact, liveStatus: 'doc' })).toMatchObject({ kindLabel: 'Doc', isArtifact: false })
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

  test('the live title replaces a link snapshot that is only the PR number', () => {
    // WHY: a link created from the number alone snapshots "#418", and the ref
    // column then strips it as a duplicate — so without the overlay the row
    // has no name. The read title is what makes the row legible.
    expect(linkRow(prLink('418', '#418'), 'Unify picker index')).toMatchObject({
      ref: '#418',
      label: 'Unify picker index',
    })
    const [row] = taskPrRows(
      [prLink('418', '#418')],
      () => null,
      () => 'Unify picker index',
    )
    expect(row.title).toBe('Unify picker index')
  })

  test('the live title also supersedes a stale link snapshot', () => {
    // WHY: a link title is written once and never updated, so a renamed PR
    // reads under its old name on every task surface until the live read wins.
    const [row] = taskPrRows(
      [prLink('418', 'Old name from link time')],
      () => null,
      () => 'The name the PR has now',
    )
    expect(row.title).toBe('The name the PR has now')
  })
})

describe('linked work providers', () => {
  const workLink = {
    taskId: '01J',
    kind: 'work',
    targetScope: '',
    targetKey: 'work-1',
    title: 'Published RFC',
    createdBy: 'user',
    linkedAt: 1,
  } satisfies TaskLink

  test('shows a provider only when the linked work has an upstream mirror', () => {
    const linkedWork = {
      id: 'work-1',
      mirroredDoc: { provider: 'confluence' },
    } as Work
    const localWork = { id: 'work-1' } as Work

    expect(linkedWorkProvider(workLink, () => linkedWork)).toBe('confluence')
    expect(linkedWorkProvider(workLink, () => localWork)).toBeNull()
    expect(linkedWorkProvider({ ...workLink, kind: 'plan' }, () => linkedWork)).toBeNull()
  })
})

describe('the Kind column becomes a group header where there is no column', () => {
  const link = (over: Partial<TaskLink>): TaskLink =>
    ({
      taskId: '01J',
      kind: 'work',
      targetScope: '',
      targetKey: 'k',
      title: 'Item',
      createdBy: 'user',
      linkedAt: 1,
      ...over,
    }) satisfies TaskLink

  test('keeps the wide table\'s kind order, so the same reader finds the same sequence', () => {
    const groups = linkGroups([
      link({ kind: 'automation', targetKey: 'a1', title: 'Nightly probe' }),
      link({ kind: 'work', targetKey: 'w1', title: 'Retrieval RFC' }),
      link({ kind: 'plan', targetKey: 'p1', title: 'Index migration' }),
      link({ kind: 'work', targetKey: 'w2', title: 'Trigger keys' }),
    ])

    expect(groups.map((group) => group.label)).toEqual(['Docs', 'Plans', 'Automations'])
    expect(groups[0].rows.map((row) => row.label)).toEqual(['Retrieval RFC', 'Trigger keys'])
  })

  test('omits a kind with nothing in it rather than heading an empty card', () => {
    const groups = linkGroups([link({ kind: 'plan', targetKey: 'p1' })])
    expect(groups.map((group) => group.kind)).toEqual(['plan'])
  })

  test('leaves pull requests to their own section, exactly as the table does', () => {
    // A PR carries a lifecycle no generic row can state, so it is never one of
    // these groups — the same rule `linkedTableLinks` enforces for the table.
    const groups = linkGroups([link({ kind: 'pr', targetKey: '418' })])
    expect(groups).toEqual([])
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
  const status = { provider: 'github', ok: true, scopeLabel: 'Ashton-Sidhu/solus' } as const

  test('offers the project provider, naming where the ticket would land', () => {
    // WHY: publishing writes to somewhere other people can see. The page names
    // which place before the user commits to it.
    expect(taskPublishTarget({ task: localTask, upstream: null, status })).toEqual({
      provider: 'GitHub',
      providerId: 'github',
      scope: 'Ashton-Sidhu/solus',
    })
  })

  test('names a Jira project the same way, without a second display path', () => {
    // WHY: the scope label is the provider's own word for where a ticket lands.
    // A second provider must not need a second field to be nameable.
    expect(taskPublishTarget({
      task: localTask,
      upstream: null,
      status: { provider: 'jira', ok: true, scopeLabel: 'ACME' },
    })).toEqual({ provider: 'Jira', providerId: 'jira', scope: 'ACME' })
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
