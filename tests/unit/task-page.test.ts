import { pullRequestFixture } from './__fixtures__/pull-request'
import { linkedPrIdentity, type LinkedPr } from '@solus/workspace-ui/contexts/prs/linked-pr'
import { describe, expect, test } from 'bun:test'
import {
  commentAuthorName,
  commentDelivery,
  commentSessionLink,
  commentSessionName,
  linkGroups,
  linkRow,
  linkedArtifactForActivity,
  linkedTableLinks,
  linkedWorkProvider,
  statusTextColor,
  taskDetailsSummary,
  taskFieldLocks,
  taskSessionRow,
  taskStateLabel,
} from '@solus/workspace-ui/components/tasks/task-page/lib/task-page'
import { taskTabs } from '@solus/workspace-ui/components/tasks/task-page/lib/task-tabs'
import { taskEpicRow } from '@solus/workspace-ui/components/tasks/task-page/lib/task-epic'
import { taskMoveGroups } from '@solus/workspace-ui/components/tasks/task-page/lib/task-move'
import { taskPrRows } from '@solus/workspace-ui/components/tasks/task-page/lib/task-prs'
import { taskRow } from '@solus/workspace-ui/components/tasks/lib/tasks-list-view'
import type { Task, TaskField, TaskLink, TaskSessionLink } from '@solus/contracts/task-types'
import type { Activity } from '@solus/contracts/activity'
import { activityLine } from '@solus/workspace-ui/components/activity/lib/activity-line'
import type { Work } from '@solus/contracts/types'
import type { User } from '@solus/contracts/user'

/** The reader on the task's host. */
const ME: User = { id: { kind: 'account', accountId: 'me' }, displayName: 'Mina Reader' }
const ALICE: User = { id: { kind: 'account', accountId: 'alice' }, displayName: 'Alice Chen' }

// Attempt naming is `sessionDisplayName`, shared by every surface that lists a
// session — see session-utils.test.ts.

describe('an artifact on the task activity feed', () => {
  const linked = {
    id: 'e1',
    subject: { kind: 'task', id: 't' },
    kind: 'task_changed',
    change: 'linked',
    by: { kind: 'agent', sessionId: 's1' },
    target: { kind: 'work', scope: '', key: 'work-1', title: 'Latency report' },
    at: 1,
  } satisfies Activity
  const artifact: TaskLink = {
    taskId: 't',
    kind: 'work',
    targetScope: '',
    targetKey: 'work-1',
    title: 'Latency report',
    liveStatus: 'artifact',
    createdBy: { kind: 'agent', sessionId: 's1' },
    linkedAt: 1,
  }

  test('a linked event shows the render it brought', () => {
    // WHY: a render is the one link worth seeing where it arrived. The feed
    // tells the story of the task, and "linked Latency report" with nothing
    // under it sends the reader to the Linked table to find out what it was.
    expect(linkedArtifactForActivity(linked, [artifact])).toBe(artifact)
  })

  test('a document, an unlinked work, and any other event get no card', () => {
    expect(linkedArtifactForActivity(linked, [{ ...artifact, liveStatus: 'doc' }])).toBeNull()
    expect(linkedArtifactForActivity(linked, [])).toBeNull()
    expect(linkedArtifactForActivity({ ...linked, change: 'unlinked' }, [artifact])).toBeNull()
    expect(linkedArtifactForActivity({ ...linked, target: { ...linked.target, kind: 'plan' } }, [artifact])).toBeNull()
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

  test('names the session when the comment carries its provider thread id', () => {
    // WHY: an agent comments under the id it knows itself by, the provider
    // thread, while the task links the stable Solus id. The card must still
    // show the session's title and open the linked session.
    const linked = { ...session, sessionId: 'stable-solus-id', agentSessionId: '01a10c74-169a-70a2-92e6-0463ff615cbe' }
    const comment = { originSessionId: '01a10c74-169a-70a2-92e6-0463ff615cbe' }
    expect(commentSessionName(comment, [linked])).toBe('Fix comment attribution')
    expect(commentSessionLink(comment, [linked])?.sessionId).toBe('stable-solus-id')
  })

  test('keeps attribution useful before the session link is indexed', () => {
    expect(commentSessionName({ originSessionId: '01M0B1F57R0HSH0R0SY2P9AMYX' }, []))
      .toBe('01M0B1F5')
    expect(commentSessionName({}, [session])).toBeNull()
  })
})

describe('the task conversation', () => {
  const link = (sessionId: string, role?: TaskSessionLink['role'], linkedAt = 1): TaskSessionLink => ({
    sessionId,
    sessionTitle: sessionId,
    provider: 'claude-code',
    model: null,
    startedAt: linkedAt,
    lastActivityAt: linkedAt,
    linkedAt,
    role,
  })

  test('a session row names who started it, and says "you" for the reader', () => {
    // WHY: an organization's task lists sessions from several people's machines;
    // the starter is how a teammate knows whose session it is. The reader's own
    // reads "you", and a session nobody recorded a starter for claims no one.
    const alice = { id: { kind: 'account' as const, accountId: 'alice' }, displayName: 'Alice Chen' }
    const started = { ...link('s', 'working'), startedBy: { kind: 'user' as const, user: alice } }
    expect(taskSessionRow(started, null, null, false, 3, null, null, { kind: 'account', accountId: 'bob' }).startedBy).toBe('Alice Chen')
    expect(taskSessionRow(started, null, null, false, 3, null, null, alice.id).startedBy).toBe('you')
    expect(taskSessionRow(link('s', 'working'), null, null, false, 3).startedBy).toBeNull()
  })

  test('the stacked rung keeps the four record sections; the conversation is the lead\'s own tab', () => {
    // WHY: the lead is talked to in its conversation pane, not on the page,
    // so the page has no Conversation tab to steal the strip's first slot.
    const tabs = taskTabs({ linked: 1, sessions: 2, activity: 3 })
    expect(tabs[0]).toEqual({ id: 'overview', label: 'Overview' })
    expect(tabs.map((tab) => tab.id)).toEqual(['overview', 'linked', 'sessions', 'activity'])
  })
})

describe('task label activity', () => {
  const event = {
    id: 'event-1',
    subject: { kind: 'task', id: 'task-1' },
    kind: 'task_changed',
    change: 'labels_changed',
    by: { kind: 'user', user: ME },
    at: 1,
  } satisfies Activity

  test('names a label that was added or removed', () => {
    // WHY: the activity feed is an audit trail. "Changed labels" does not say
    // what changed and forces the reader to reconstruct old task state.
    expect(activityLine({ ...event, from: '[]', to: '["bug"]' }, ME.id).text)
      .toBe('You added label “bug”')
    expect(activityLine({ ...event, from: '["bug"]', to: '[]' }, ME.id).text)
      .toBe('You removed label “bug”')
  })

  test('names both sides of a replacement and handles several labels', () => {
    expect(activityLine({
      ...event,
      from: '["old"]',
      to: '["design","ready"]',
    }, ME.id).text).toBe('You added labels “design” and “ready” and removed label “old”')
  })

  test('names the person who did it, and "You" only for the reader', () => {
    // WHY: on a shared task every change used to read "You" (plan 012 §2). The
    // doer is a user; the reader is told apart by user id, not by name.
    const added = { ...event, from: '[]', to: '["bug"]' }
    expect(activityLine({ ...added, by: { kind: 'user', user: ALICE } }, ME.id).text).toBe('Alice Chen added label “bug”')
    expect(activityLine({ ...added, by: { kind: 'user', user: { ...ME, displayName: 'Renamed' } } }, ME.id).text).toBe('You added label “bug”')
    expect(activityLine(added, null).text).toBe('Mina Reader added label “bug”')
  })

  test('an agent’s change names whose agent it was', () => {
    const added = { ...event, from: '[]', to: '["bug"]' }
    expect(activityLine({ ...added, by: { kind: 'agent', sessionId: 's1', provider: 'codex', for: ALICE } }, ME.id).text).toBe("Alice's agent added label “bug”")
    expect(activityLine({ ...added, by: { kind: 'agent', sessionId: 's1', for: ME } }, ME.id).text).toBe('Solus agent added label “bug”')
    expect(activityLine({ ...added, by: { kind: 'agent', sessionId: 's1' } }, ME.id).text).toBe('An agent added label “bug”')
  })

  test('a row without a readable snapshot still reads, rather than taking the page down', () => {
    // WHY: this runs on a render path. One malformed or snapshot-less event
    // must not throw out of the derived that draws the whole activity list.
    expect(activityLine({ ...event, from: null, to: '["bug"]' }, ME.id).text).toBe('You changed the labels')
    expect(activityLine({ ...event, from: '{', to: '["bug"]' }, ME.id).text).toBe('You changed the labels')
    expect(activityLine({ ...event, from: '[1]', to: '["bug"]' }, ME.id).text).toBe('You changed the labels')
    expect(activityLine({ ...event, from: '["bug"]', to: '["bug"]' }, ME.id).text).toBe('You changed the labels')
  })
})

describe('task list assignee avatars', () => {
  test('uses the provider avatar for an assigned GitHub task', () => {
    // WHY: an issue assigned to the connected GitHub user should show their
    // recognizable profile image on the tasks page, not generated initials.
    const task = {
      id: 'github:I_31',
      providerId: 'github',
      kind: 'issue',
      reference: 'example/solus#31',
      title: 'GitHub issue',
      body: '',
      state: { name: 'Open', category: 'open' },
      category: 'open',
      placements: [],
      writableFields: [],
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

describe('linked pull requests', () => {
  const prLink = (targetKey: string, title: string): TaskLink => ({
    taskId: '01J',
    kind: 'pr',
    targetScope: '/repo',
    targetKey,
    title,
    createdBy: { kind: 'user', user: ME },
    linkedAt: 1,
  })

  const resolved = (link: TaskLink, title = link.title, state: 'open' | 'merged' = 'merged'): LinkedPr => ({
    ...linkedPrIdentity(link, '/repo')!, title,
    pullRequest: pullRequestFixture(Number(link.targetKey), { state, title }),
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
      createdBy: { kind: 'user', user: ME },
      linkedAt: 2,
    } satisfies TaskLink]
    expect(linkedTableLinks(links).map((link) => link.kind)).toEqual(['work'])
  })

  test('rows carry live state when a PR is known, and none when it is not', () => {
    // WHY: an unread PR must render without a state rather than defaulting to
    // "Open" — a merged PR shown as open is worse than no badge at all.
    const rows = taskPrRows(
      [prLink('418', 'Unify picker index'), prLink('421', 'Delete file picker')],
      (link) => link.targetKey === '418' ? resolved(link) : null,
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
      createdBy: { kind: 'agent', sessionId: 's1' },
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
      (link) => resolved(link, 'Unify picker index'),
    )
    expect(row.title).toBe('Unify picker index')
  })

  test('the live title also supersedes a stale link snapshot', () => {
    // WHY: a link title is written once and never updated, so a renamed PR
    // reads under its old name on every task surface until the live read wins.
    const [row] = taskPrRows(
      [prLink('418', 'Old name from link time')],
      (link) => resolved(link, 'The name the PR has now'),
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
    createdBy: { kind: 'user', user: ME },
    linkedAt: 1,
  } satisfies TaskLink

  test('shows a provider only when the linked work has a mirrored doc', () => {
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
      createdBy: { kind: 'user', user: ME },
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

describe('the Epic row', () => {
  test('is absent for a task with no epic', () => {
    // WHY: Solus never assigns an epic, so an empty row would offer an action
    // that does not exist.
    expect(taskEpicRow({})).toBeNull()
  })

  test('names the epic by title and provider reference, and opens it on the provider', () => {
    expect(taskEpicRow({
      epic: { provider: 'github', externalId: '3', url: 'https://github.com/acme/app/issues/3', title: 'Release 2.0', body: 'long description' },
    })).toEqual({
      providerId: 'github',
      title: 'Release 2.0',
      ref: '#3',
      url: 'https://github.com/acme/app/issues/3',
      hint: 'Open GitHub #3 — Release 2.0',
    })
    expect(taskEpicRow({
      epic: { provider: 'jira', externalId: 'ACME-1', url: '', title: 'Release', body: '' },
    })?.ref).toBe('ACME-1')
  })
})

describe('taskDetailsSummary', () => {
  const isoDay = (offsetDays: number) => {
    const d = new Date()
    d.setDate(d.getDate() + offsetDays)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  test('an untouched task has nothing to preview, so Details stands alone', () => {
    expect(taskDetailsSummary({ labels: [] })).toEqual({ assignee: null, due: null, labels: null })
  })

  test('a blank assignee is not a person to show', () => {
    expect(taskDetailsSummary({ assignee: '  ', labels: [] }).assignee).toBeNull()
  })

  test('previews who has it, when it is due, and its labels folded to one', () => {
    const summary = taskDetailsSummary({ assignee: 'ada', dueDate: isoDay(-3), labels: ['bug', 'ui', 'p1'] })
    expect(summary.assignee).toBe('ada')
    expect(summary.due).toEqual({ label: '3d overdue', tone: 'overdue' })
    expect(summary.labels).toBe('bug +2')
  })

  test('a single label is named without a count', () => {
    expect(taskDetailsSummary({ dueDate: isoDay(0), labels: ['bug'] })).toEqual({
      assignee: null,
      due: { label: 'Today', tone: 'soon' },
      labels: 'bug',
    })
  })
})

describe('the status of a task', () => {
  test('is the provider\'s own state name, with the category for the glyph and colour', () => {
    // WHY: GitHub and Jira own the status. "In QA" must read "In QA", not a
    // Solus word for it; only the colour comes from the coarse category.
    expect(taskStateLabel({ state: { name: 'In QA', category: 'active' }, category: 'active' })).toBe('In QA')
    expect(statusTextColor('active')).toContain('var(--running)')
    expect(statusTextColor('done')).toContain('var(--success)')
  })

  test('a task that no host described yet reads as its category, not as a blank', () => {
    expect(taskStateLabel({ state: { name: '', category: 'open' }, category: 'open' })).toBe('Open')
  })
})

describe('the move menu', () => {
  const board = {
    label: 'Roadmap',
    columns: [
      { id: 'c1', name: 'Backlog', category: 'open' as const },
      { id: 'c2', name: 'Doing', category: 'active' as const },
      { id: 'c3', name: 'Shipped', category: 'done' as const },
    ],
  }
  const repo = {
    label: 'acme/app',
    columns: [
      { id: 'open', name: 'Open', category: 'open' as const },
      { id: 'closed', name: 'Closed', category: 'done' as const },
    ],
  }
  const sources = new Map([['github-project:acme/1', board], ['github-repo:acme/app', repo]])

  test('offers the columns of each source that lists the task, in the provider\'s order', () => {
    // WHY: a column belongs to one source, and the columns of two sources do
    // not line up. A move must name the source and its column, or the host
    // cannot know which board the person meant.
    const groups = taskMoveGroups({
      category: 'active',
      placements: [
        { sourceKey: 'github-project:acme/1', columnId: 'c2' },
        { sourceKey: 'github-repo:acme/app', columnId: 'open' },
      ],
    }, sources)
    expect(groups.map((group) => group.label)).toEqual(['Roadmap', 'acme/app'])
    expect(groups[0]?.options.map((option) => option.label)).toEqual(['Backlog', 'Doing', 'Shipped'])
    expect(groups[0]?.options[2]?.target).toEqual({ sourceKey: 'github-project:acme/1', columnId: 'c3' })
    expect(groups[1]?.options[1]?.target).toEqual({ sourceKey: 'github-repo:acme/app', columnId: 'closed' })
  })

  test('marks the column the task is in, and none for a board item with no column', () => {
    const placed = taskMoveGroups({ category: 'active', placements: [{ sourceKey: 'github-project:acme/1', columnId: 'c2' }] }, sources)
    expect(placed[0]?.options.filter((option) => option.current).map((option) => option.label)).toEqual(['Doing'])
    const unplaced = taskMoveGroups({ category: 'open', placements: [{ sourceKey: 'github-project:acme/1', columnId: null }] }, sources)
    expect(unplaced[0]?.options.some((option) => option.current)).toBe(false)
  })

  test('offers the three status categories when no source of the task has columns', () => {
    // WHY: a task that only a session link brought here, or a source that no
    // host described yet, has no columns to show. The person can still move
    // the task: the host chooses the column for a status category.
    for (const placements of [[], [{ sourceKey: 'jira-board:x/9', columnId: 'c' }]]) {
      const groups = taskMoveGroups({ category: 'active', placements }, sources)
      expect(groups).toHaveLength(1)
      expect(groups[0]?.label).toBeNull()
      expect(groups[0]?.options.map((option) => option.target)).toEqual([
        { category: 'open' }, { category: 'active' }, { category: 'done' },
      ])
      expect(groups[0]?.options.find((option) => option.current)?.label).toBe('Active')
    }
  })
})

describe('which fields the page lets the person edit', () => {
  const taskWith = (writable: TaskField[]) => ({
    providerId: 'github' as const,
    canWrite: (field: TaskField) => writable.includes(field),
  })

  test('an editor is enabled only for a field that the provider takes for this task', () => {
    // WHY: a GitHub issue takes a due date only when a Project it is on has
    // that field. An editor for another field would end in a refused write.
    const locks = taskFieldLocks(taskWith(['title', 'body', 'labels']))
    expect(locks.title).toBeNull()
    expect(locks.body).toBeNull()
    expect(locks.labels).toBeNull()
    expect(locks.dueDate).not.toBeNull()
    expect(locks.priority).not.toBeNull()
    expect(locks.assignee).not.toBeNull()
  })

  test('a disabled editor says which provider does not take the field', () => {
    expect(taskFieldLocks(taskWith([])).dueDate)
      .toBe('GitHub does not take a change of the due date for this task')
  })
})

describe('a comment that the provider did not take', () => {
  test('a comment on the provider has no delivery state to show', () => {
    expect(commentDelivery({})).toEqual({ state: 'sent' })
    // A send error left from an earlier attempt does not make a sent comment unsent.
    expect(commentDelivery({ unsent: false, sendError: 'old' })).toEqual({ state: 'sent' })
  })

  test('an unsent comment shows why, so the person can retry or discard it', () => {
    // WHY: the comment is on this host only. Without the reason the person
    // cannot tell a lost connection from a refused comment.
    expect(commentDelivery({ unsent: true, sendError: 'Resource not accessible' }))
      .toEqual({ state: 'unsent', error: 'Resource not accessible' })
  })

  test('an unsent comment with no recorded reason still says that it was not sent', () => {
    expect(commentDelivery({ unsent: true })).toEqual({ state: 'unsent', error: 'The provider did not take this comment.' })
  })
})

describe('who wrote a comment', () => {
  test('a comment sent from Solus names its person, and "You" for the reader', () => {
    expect(commentAuthorName({ author: { kind: 'user', user: ALICE } }, ME.id)).toBe('Alice Chen')
    expect(commentAuthorName({ author: { kind: 'user', user: ME } }, ME.id)).toBe('You')
  })

  test('a comment read from the provider names the provider\'s author', () => {
    // WHY: Solus did not send it, so it has no Solus attribution. The
    // provider's login is the only name there is.
    expect(commentAuthorName({ externalAuthor: 'octocat' }, ME.id)).toBe('octocat')
    expect(commentAuthorName({ externalAuthor: null }, ME.id)).toBe('Unknown')
  })
})
