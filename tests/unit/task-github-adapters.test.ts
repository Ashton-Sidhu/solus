import { describe, expect, mock, test } from 'bun:test'
import { issueKey } from '@solus/contracts/task-sources'
import type { IssueSource } from '@solus/contracts/task-sources'
import type { GitHubClient } from '@solus/server/providers/github/octokit'
import type { GithubRun, SourceWriteState, TaskHome } from '@solus/server/data/tasks/providers/types'
import { DatabaseSync } from './helpers/bun-sqlite'

mock.module('node:sqlite', () => ({ DatabaseSync }))

const { GitHubTaskProvider, githubIssueDetails, readIssueNode } = await import('@solus/server/data/tasks/providers/github')
const { readGithubIssueTimeline } = await import('@solus/server/data/tasks/providers/github-issue-timeline')
const { draftToTask, issueToTask } = await import('@solus/server/data/tasks/providers/github-model')
const { GitHubRepoSource } = await import('@solus/server/data/tasks/sources/github-repo')
const { GitHubProjectSource } = await import('@solus/server/data/tasks/sources/github-project')
const { TaskProviderError, MAX_SOURCE_TASKS } = await import('@solus/server/data/tasks/providers/types')

// GitHub owns each task. These tests pin what Solus reads from a GitHub answer
// and what it sends for a write, with recorded answer shapes and no network.

interface GraphqlCall {
  query: string
  variables: { [name: string]: unknown }
}

interface RestCall {
  method: string
  params: { [name: string]: unknown }
}

interface FakeRest {
  [method: string]: (params: { [name: string]: unknown }) => unknown
}

/** A `GithubRun` whose GraphQL client answers by query text and whose REST
 *  client answers by method name. Each call is recorded. */
function fakeGithub(answer: (call: GraphqlCall) => unknown, rest: FakeRest = {}) {
  const graphqlCalls: GraphqlCall[] = []
  const restCalls: RestCall[] = []
  const restMethods = (group: string[]) => Object.fromEntries(group.map((method) => [
    method,
    async (params: { [name: string]: unknown }) => {
      restCalls.push({ method, params })
      const handler = rest[method]
      if (!handler) throw new Error(`unexpected REST call ${method}`)
      return { data: await handler(params) }
    },
  ]))
  const client = {
    graphql: async (query: string, variables: GraphqlCall['variables'] = {}) => {
      const call = { query, variables }
      graphqlCalls.push(call)
      return answer(call)
    },
    rest: {
      issues: restMethods(['update', 'create', 'createComment', 'listAssignees']),
      search: restMethods(['issuesAndPullRequests']),
    },
  } as unknown as Pick<GitHubClient, 'rest' | 'graphql'>
  const run: GithubRun = (_operation, operation) => operation(client)
  return { run, graphqlCalls, restCalls }
}

const previewError = Object.assign(new Error('GitHub refused the status field'), {
  errors: [{ message: "Field 'status' doesn't exist on type 'Issue'" }],
})

const STATUS_FIELD = {
  __typename: 'ProjectV2SingleSelectField',
  id: 'FIELD_status',
  name: 'Status',
  dataType: 'SINGLE_SELECT',
  options: [
    { id: 'opt_todo', name: 'Todo' },
    { id: 'opt_doing', name: 'In progress' },
    { id: 'opt_done', name: 'Done' },
  ],
}

function statusValue(optionId: string, name: string) {
  return { __typename: 'ProjectV2ItemFieldSingleSelectValue', name, optionId, field: { name: 'Status' } }
}

interface IssueOverrides {
  [field: string]: unknown
}

/** An issue node as the issue selection answers it. */
function issueNode(overrides: IssueOverrides = {}) {
  return {
    __typename: 'Issue',
    id: 'I_node7',
    number: 7,
    title: 'Ship the thing',
    body: 'Body',
    state: 'OPEN',
    url: 'https://github.com/acme/app/issues/7',
    createdAt: '2026-07-30T10:00:00Z',
    updatedAt: '2026-08-01T10:00:00Z',
    repository: { owner: { login: 'acme' }, name: 'app' },
    labels: { nodes: [{ name: 'p1' }] },
    assignees: { nodes: [{ login: 'ada', avatarUrl: 'https://avatars/ada' }] },
    parent: null,
    projectItems: { nodes: [] },
    ...overrides,
  }
}

function draftNode(id = 'DI_draft1', title = 'Sketch the flow') {
  return {
    __typename: 'DraftIssue',
    id,
    title,
    body: 'Rough notes',
    createdAt: '2026-08-02T10:00:00Z',
    updatedAt: '2026-08-03T10:00:00Z',
    assignees: { nodes: [] },
  }
}

/** A board item of the issue, in a Project with the given field definitions. */
function boardItem(fields: Array<{ id?: string; name: string; dataType: string; options?: Array<{ id: string; name: string }> }>, values: unknown[] = []) {
  return { id: 'PVTI_issue', project: { id: 'PVT_1', fields: { nodes: fields } }, fieldValues: { nodes: values } }
}

function projectAnswer(nodes: unknown[], pageInfo = { hasNextPage: false, endCursor: null as string | null }) {
  return {
    repositoryOwner: {
      projectV2: {
        id: 'PVT_1',
        title: 'Launch board',
        fields: { nodes: [{ __typename: 'ProjectV2Field', id: 'FIELD_title', name: 'Title', dataType: 'TITLE' }, STATUS_FIELD] },
        items: { totalCount: nodes.length, pageInfo, nodes },
      },
    },
  }
}

const REPO_SOURCE: IssueSource = { kind: 'github-repo', owner: 'acme', repo: 'app' }
const PROJECT_SOURCE: IssueSource = { kind: 'github-project', owner: 'acme', number: 4 }
const PROJECT_WRITE_STATE: SourceWriteState = { kind: 'github-project', projectId: 'PVT_1', statusFieldId: 'FIELD_status' }
const ISSUE_HOME: TaskHome = { provider: 'github', kind: 'issue', owner: 'acme', repo: 'app', number: 7 }
const DRAFT_HOME: TaskHome = { provider: 'github', kind: 'draft', projectId: 'PVT_1', itemId: 'PVTI_draft' }
/** The host's copy of acme/app#7 as a read stored it, which a write receives. */
const CURRENT = issueToTask(issueNode())

describe('the identity of a GitHub task', () => {
  test('an issue is named by its node id and shown by the repository it is in now', async () => {
    // WHY: GitHub can transfer an issue to another repository. The node id
    // stays, so the task key stays; the reference a person reads must follow
    // the issue, not the source that listed it.
    const moved = issueNode({ repository: { owner: { login: 'acme' }, name: 'platform' }, url: 'https://github.com/acme/platform/issues/7' })
    const { run } = fakeGithub(() => ({ node: { ...moved, comments: { totalCount: 0, nodes: [] } } }))

    const { task } = await new GitHubTaskProvider(run).fetch({ provider: 'github', id: 'I_node7' })

    expect(issueKey(task.ref)).toBe('github:I_node7')
    expect(task.reference).toBe('acme/platform#7')
    expect(task.home).toMatchObject({ provider: 'github', kind: 'issue', owner: 'acme', repo: 'platform', number: 7 })
    expect(task.state).toEqual({ name: 'Open', category: 'open' })
  })

  test('a draft is named by the draft node id and has no reference or URL', async () => {
    // WHY: a draft item is in no repository. Its home is its Project and its
    // board item, and its state is the Status option the board gives it.
    const { run } = fakeGithub(() => ({
      node: {
        ...draftNode(),
        projectV2Items: {
          nodes: [{ id: 'PVTI_draft', project: { id: 'PVT_1' }, fieldValues: { nodes: [statusValue('opt_doing', 'In progress')] } }],
        },
      },
    }))

    const details = await new GitHubTaskProvider(run).fetch({ provider: 'github', id: 'DI_draft1' })

    expect(issueKey(details.task.ref)).toBe('github:DI_draft1')
    expect(details.task.kind).toBe('draft')
    expect(details.task.reference).toBeUndefined()
    expect(details.task.url).toBeNull()
    expect(details.task.home).toEqual(DRAFT_HOME)
    expect(details.task.state).toEqual({ name: 'In progress', category: 'active' })
    expect(details.task.writableFields).toEqual(['title', 'body', 'assignee'])
    expect(details.comments).toEqual([])
  })

  test('a task that GitHub does not give is a no-access failure', async () => {
    const { run } = fakeGithub(() => ({ node: null }))
    const read = new GitHubTaskProvider(run).fetch({ provider: 'github', id: 'I_gone' })
    await expect(read).rejects.toBeInstanceOf(TaskProviderError)
    await expect(read).rejects.toMatchObject({ health: 'no_access' })
  })

  test('the GitHub provider refuses a Jira task', async () => {
    const { run, graphqlCalls } = fakeGithub(() => ({ node: null }))
    await expect(new GitHubTaskProvider(run).fetch({ provider: 'jira', cloudId: 'c', id: '1' })).rejects.toThrow(/jira/i)
    expect(graphqlCalls).toHaveLength(0)
  })
})

describe('reading one issue', () => {
  test('the detail read carries the newest history, and an older page is one query', async () => {
    // WHY: the issue page used a second request for history, and GitHub's REST
    // timeline cost two more calls and read the comments again. One GraphQL
    // connection serves both, and older comments still arrive with their page.
    const timeline = (nodes: unknown[], hasPreviousPage: boolean) => ({ pageInfo: { hasPreviousPage, startCursor: hasPreviousPage ? 'older' : null }, nodes })
    const sha = '8a81adf' + 'a'.repeat(33)
    const { run, graphqlCalls, restCalls } = fakeGithub(({ query }) => query.includes('query IssueTimeline')
      ? { node: { __typename: 'Issue', timelineItems: timeline([
          { __typename: 'IssueComment', id: 'IC_old', createdAt: '2024-05-30T12:00:00Z', body: 'Older comment', author: { login: 'ada' } },
        ], false) } }
      : { node: issueNode({
          author: null, reactionGroups: [], comments: { totalCount: 0, nodes: [] },
          closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          timelineItems: timeline([
            { __typename: 'ReferencedEvent', id: 'RE_1', createdAt: '2025-09-22T12:00:00Z', actor: { login: 'stainless-app' }, commit: { oid: sha, url: `https://github.com/acme/app/commit/${sha}` } },
            { __typename: 'CrossReferencedEvent', id: 'CR_1', createdAt: '2025-09-23T12:00:00Z', actor: { login: 'ada' },
              source: { __typename: 'PullRequest', number: 9, title: 'Fix it', url: 'https://github.com/acme/app/pull/9', pullRequestState: 'MERGED', merged: true } },
          ], true),
        }) })

    const result = await new GitHubTaskProvider(run).fetch({ provider: 'github', id: 'I_node7' }, { providerMetadata: true })
    expect(graphqlCalls).toHaveLength(1)
    expect(restCalls).toHaveLength(0)
    expect(result.providerMetadata?.events).toMatchObject([
      { actor: 'stainless-app', link: { label: '8a81adf', url: `https://github.com/acme/app/commit/${sha}` } },
      { text: 'referenced this issue', link: { url: 'https://github.com/acme/app/pull/9' } },
    ])
    expect(result.providerMetadata?.pullRequests).toMatchObject([{ number: 9, state: 'merged' }])
    expect(result.providerMetadata?.historyCursor).toBe('older')

    const earlier = await run('older_history', ({ graphql }) => readGithubIssueTimeline(graphql, 'github:I_node7', 'I_node7', 'older'))
    expect(graphqlCalls).toHaveLength(2)
    expect(graphqlCalls[1]?.variables).toEqual({ id: 'I_node7', cursor: 'older' })
    expect(earlier?.comments).toMatchObject([{ providerCommentId: 'IC_old', body: 'Older comment' }])
    expect(earlier?.historyCursor).toBeNull()
  })

  test('gets the issue, latest comments, and reactions in one provider request', async () => {
    const { run, graphqlCalls, restCalls } = fakeGithub(() => ({
      repository: { issue: issueNode({
        author: { login: 'ada' },
        reactionGroups: [],
        closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        comments: {
          totalCount: 1,
          nodes: [{
            id: 'IC_1', author: null, body: 'Latest comment', createdAt: '2026-08-01T09:00:00Z',
            reactionGroups: [{ content: 'THUMBS_UP', users: { totalCount: 2 }, viewerHasReacted: false }],
          }],
        },
      }) },
    }))

    const result = await run('resolve_github_issue', async ({ graphql }) =>
      githubIssueDetails(await readIssueNode(graphql, { owner: 'acme', repo: 'app', number: 7 }, true), graphql))

    expect(result.task.title).toBe('Ship the thing')
    expect(result.comments[0]?.body).toBe('Latest comment')
    expect(result.providerMetadata?.reactions).toEqual([
      { targetId: 'IC_1', content: 'THUMBS_UP', count: 2, viewerHasReacted: false },
    ])
    expect(graphqlCalls).toHaveLength(1)
    expect(graphqlCalls[0]?.variables).toEqual({ owner: 'acme', repo: 'app', number: 7 })
    expect(graphqlCalls[0]?.query).toContain('comments(last: 100)')
    expect(graphqlCalls[0]?.query).toContain('timelineItems(last: 100')
    expect(restCalls).toHaveLength(0)
  })

  test('reads only the closing pull request connection when it has another page', async () => {
    const pr = (number: number) => ({
      number, title: `Fix ${number}`, url: `https://github.com/acme/app/pull/${number}`, state: 'OPEN',
    })
    const { run, graphqlCalls } = fakeGithub(({ query }) => query.includes('query IssueClosingPullRequests')
      ? { node: { closedByPullRequestsReferences: { nodes: [pr(9)], pageInfo: { hasNextPage: false, endCursor: null } } } }
      : { node: issueNode({
          author: null, reactionGroups: [], comments: { totalCount: 0, nodes: [] },
          closedByPullRequestsReferences: { nodes: [pr(8)], pageInfo: { hasNextPage: true, endCursor: 'more' } },
        }) })
    const result = await new GitHubTaskProvider(run).fetch({ provider: 'github', id: 'I_node7' }, { providerMetadata: true })
    expect(graphqlCalls).toHaveLength(2)
    expect(graphqlCalls[0]?.query).toContain('closedByPullRequestsReferences(first: 20')
    expect(graphqlCalls[1]?.variables).toEqual({ id: 'I_node7', cursor: 'more' })
    expect(graphqlCalls[1]?.query).not.toContain('comments')
    expect(result.providerMetadata?.pullRequests.map((pullRequest) => pullRequest.number)).toEqual([8, 9])
  })

  test('gives the comments, says when there are more, and gives the epic with its description', async () => {
    // WHY: the agent gets the comments and the description of the epic as
    // context. Solus reads 100 comments, so it must say when the issue has more.
    const { run, graphqlCalls } = fakeGithub(() => ({
      node: {
        ...issueNode({
          parent: { number: 3, title: 'Release 2.0', url: 'https://github.com/acme/app/issues/3', body: 'Every client in one week.' },
        }),
        comments: {
          totalCount: 140,
          nodes: [{ id: 'IC_1', author: { login: 'grace' }, body: 'Looks good', createdAt: '2026-08-01T09:00:00Z' }],
        },
      },
    }))

    const details = await new GitHubTaskProvider(run).fetch({ provider: 'github', id: 'I_node7' })

    expect(details.comments).toEqual([
      { id: 'IC_1', author: 'grace', body: 'Looks good', createdAt: Date.parse('2026-08-01T09:00:00Z') },
    ])
    expect(details.commentsTruncated).toBe(true)
    expect(details.task.epic).toEqual({
      provider: 'github',
      externalId: '3',
      url: 'https://github.com/acme/app/issues/3',
      title: 'Release 2.0',
      body: 'Every client in one week.',
    })
    expect(graphqlCalls[0]?.query).toContain('parent { body }')
    expect(graphqlCalls[0]?.variables).toEqual({ id: 'I_node7' })
  })
})

describe('the fields a GitHub issue takes', () => {
  test('an issue on no Project takes no priority or due date, and reads its priority from labels', async () => {
    // WHY: GitHub has no priority or due date on an issue. Solus must not
    // offer a field that the provider cannot hold.
    const { run } = fakeGithub(() => ({ node: { ...issueNode(), comments: { totalCount: 0, nodes: [] } } }))
    const { task } = await new GitHubTaskProvider(run).fetch({ provider: 'github', id: 'I_node7' })
    expect(task.writableFields).toEqual(['title', 'body', 'labels', 'assignee'])
    expect(task.priority).toBe('high')
    expect(task.dueDate).toBeUndefined()
  })

  test('an issue on a Project with a Priority field and a date field takes both, and reads them from the board', async () => {
    // WHY: on a board the priority is the board's field. A `p1` label must not
    // contradict the Priority option that the board shows.
    const item = boardItem(
      [{ name: 'Priority', dataType: 'SINGLE_SELECT' }, { name: 'Due date', dataType: 'DATE' }],
      [
        { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'Urgent', optionId: 'o1', field: { name: 'Priority' } },
        { __typename: 'ProjectV2ItemFieldDateValue', date: '2026-09-01', field: { name: 'Due date' } },
      ],
    )
    const { run } = fakeGithub(() => ({
      node: { ...issueNode({ projectItems: { nodes: [item] } }), comments: { totalCount: 0, nodes: [] } },
    }))
    const { task } = await new GitHubTaskProvider(run).fetch({ provider: 'github', id: 'I_node7' })
    expect(task.writableFields).toEqual(['title', 'body', 'labels', 'assignee', 'priority', 'dueDate'])
    expect(task.priority).toBe('urgent')
    expect(task.dueDate).toBe('2026-09-01')
  })

  test('a Project with only a Status field adds no writable field', async () => {
    const item = boardItem([{ name: 'Status', dataType: 'SINGLE_SELECT' }])
    const { run } = fakeGithub(() => ({
      node: { ...issueNode({ projectItems: { nodes: [item] } }), comments: { totalCount: 0, nodes: [] } },
    }))
    const { task } = await new GitHubTaskProvider(run).fetch({ provider: 'github', id: 'I_node7' })
    expect(task.writableFields).toEqual(['title', 'body', 'labels', 'assignee'])
  })
})

describe('writing to a GitHub issue', () => {
  test('an update is one REST write, and answers the host copy with the written fields', async () => {
    // WHY: a read after the write cost a second call, and GitHub's GraphQL
    // reads lag its REST writes, so it could give the issue as it was.
    const { run, restCalls, graphqlCalls } = fakeGithub(
      () => { throw new Error('An update reads nothing.') },
      { update: () => ({ updated_at: '2026-08-05T10:00:00Z' }) },
    )

    const task = await new GitHubTaskProvider(run).update(ISSUE_HOME, { labels: ['bug', 'urgent'], assignee: null }, issueToTask(issueNode()))

    expect(graphqlCalls).toHaveLength(0)
    expect(task.updatedAt).toBe(Date.parse('2026-08-05T10:00:00Z'))
    expect(task.title).toBe(issueToTask(issueNode()).title)
    expect(restCalls).toEqual([{
      method: 'update',
      params: { owner: 'acme', repo: 'app', issue_number: 7, labels: ['bug', 'urgent'], assignees: [] },
    }])
    expect(task.labels).toEqual(['bug', 'urgent'])
    expect(task.priority).toBe('urgent')
    expect(task.assignee).toBeUndefined()
  })

  test('priority and due date are one mutation, with the ids of the host copy and no read first', async () => {
    // WHY: the board item, field and option ids come with each read of the
    // issue. Reading them again before a write cost two more calls.
    const item = boardItem([
      { id: 'FIELD_priority', name: 'Priority', dataType: 'SINGLE_SELECT', options: [{ id: 'opt_p0', name: 'P0' }, { id: 'opt_p2', name: 'P2' }] },
      { id: 'FIELD_start', name: 'Start', dataType: 'DATE' },
      { id: 'FIELD_due', name: 'Due date', dataType: 'DATE' },
    ])
    const { run, graphqlCalls, restCalls } = fakeGithub(() => ({}))
    const current = issueToTask(issueNode({ projectItems: { nodes: [item] } }))

    const task = await new GitHubTaskProvider(run).update(current.home, { priority: 'medium', dueDate: null }, current)

    expect(graphqlCalls).toHaveLength(1)
    expect(graphqlCalls[0]?.query).toContain('priority: updateProjectV2ItemFieldValue')
    expect(graphqlCalls[0]?.query).toContain('dueDate: clearProjectV2ItemFieldValue')
    expect(graphqlCalls[0]?.variables).toEqual({
      priorityProject: 'PVT_1', priorityItem: 'PVTI_issue', priorityField: 'FIELD_priority', priorityValue: { singleSelectOptionId: 'opt_p2' },
      dueDateProject: 'PVT_1', dueDateItem: 'PVTI_issue', dueDateField: 'FIELD_due',
    })
    expect(restCalls).toHaveLength(0)
    expect(task.priority).toBe('medium')
    expect(task.dueDate).toBeUndefined()
  })

  test('a host copy stored without board items reads them once before the write', async () => {
    const item = boardItem([{ id: 'FIELD_priority', name: 'Priority', dataType: 'SINGLE_SELECT', options: [{ id: 'opt_p2', name: 'P2' }] }])
    const { run, graphqlCalls } = fakeGithub(({ query }) => query.includes('mutation')
      ? {}
      : { repository: { issue: issueNode({ projectItems: { nodes: [item] } }) } })
    const current = issueToTask(issueNode({ projectItems: { nodes: [item] } }))

    await new GitHubTaskProvider(run).update(ISSUE_HOME, { priority: 'medium' }, current)

    expect(graphqlCalls).toHaveLength(2)
    expect(graphqlCalls[1]?.variables).toMatchObject({ priorityValue: { singleSelectOptionId: 'opt_p2' } })
  })

  test('a due date for an issue on no Project fails and writes nothing', async () => {
    // WHY: a silent success would show a due date that GitHub does not hold.
    const { run, graphqlCalls } = fakeGithub(() => ({ repository: { issue: issueNode() } }))
    const current = issueToTask(issueNode({ projectItems: { nodes: [] } }))
    await expect(new GitHubTaskProvider(run).update(current.home, { dueDate: '2026-09-01' }, current))
      .rejects.toThrow(/no GitHub Project with a date field/)
    expect(graphqlCalls).toHaveLength(0)
  })

  test('done closes the issue, and open or active reopens it', async () => {
    // WHY: GitHub has no state for work in progress, so `active` is an open issue.
    const { run, restCalls } = fakeGithub(
      () => ({ repository: { issue: issueNode() } }),
      { update: () => ({}) },
    )
    const provider = new GitHubTaskProvider(run)

    const closed = await provider.setState(ISSUE_HOME, 'done', CURRENT)
    await provider.setState(ISSUE_HOME, 'active', CURRENT)

    expect(restCalls.map((call) => call.params.state)).toEqual(['closed', 'open'])
    // The read after the write is stale (still OPEN); the answer is not.
    expect(closed.state).toEqual({ name: 'Closed', category: 'done' })
  })

  test('a comment answers the node id, which is the id a later read gives', async () => {
    // WHY: with the REST id, the next read would show the comment a second time.
    const { run } = fakeGithub(() => ({}), {
      createComment: () => ({ id: 991, node_id: 'IC_new', user: { login: 'ada' }, body: 'Done', created_at: '2026-08-04T10:00:00Z' }),
    })
    expect(await new GitHubTaskProvider(run).comment(ISSUE_HOME, 'Done')).toEqual({
      id: 'IC_new',
      author: 'ada',
      body: 'Done',
      createdAt: Date.parse('2026-08-04T10:00:00Z'),
    })
  })

  test('an issue cannot be deleted', async () => {
    // WHY: GitHub owns the content. Solus removes only a draft item of a Project.
    const { run, graphqlCalls, restCalls } = fakeGithub(() => ({}))
    await expect(new GitHubTaskProvider(run).remove(ISSUE_HOME))
      .rejects.toThrow('An issue cannot be deleted from Solus. Close it instead.')
    expect(graphqlCalls).toHaveLength(0)
    expect(restCalls).toHaveLength(0)
  })
})

describe('writing to a draft item', () => {
  test('an update addresses the draft by the id of the host copy, with no read first', async () => {
    // WHY: `updateProjectV2DraftIssue` takes the draft id, which the host copy
    // holds as its id. Reading the board item for it cost a call.
    const { run, graphqlCalls } = fakeGithub(() => ({ updateProjectV2DraftIssue: { draftIssue: draftNode('DI_draft1', 'New title') } }))
    const current = draftToTask(draftNode(), { projectId: 'PVT_1', itemId: 'PVTI_draft', statusName: 'Todo' })

    const task = await new GitHubTaskProvider(run).update(DRAFT_HOME, { title: 'New title' }, current)

    expect(graphqlCalls).toHaveLength(1)
    expect(graphqlCalls[0]?.variables).toMatchObject({ draftIssueId: 'DI_draft1', title: 'New title' })
    expect(task.title).toBe('New title')
    expect(task.state).toEqual({ name: 'Todo', category: 'open' })
    expect(task.home).toEqual(DRAFT_HOME)
  })

  test('a draft has no state, takes no comment, and holds no attachment', async () => {
    const { run, graphqlCalls } = fakeGithub(() => ({}))
    const provider = new GitHubTaskProvider(run)
    const body = `![shot](asset://${'a'.repeat(64)}.png)`

    await expect(provider.setState(DRAFT_HOME, 'done', CURRENT)).rejects.toThrow(/no state of its own/)
    await expect(provider.comment(DRAFT_HOME, 'hello')).rejects.toThrow(/takes no comments/)
    expect(provider.unpublishableAssets(DRAFT_HOME, body)).toHaveLength(1)
    await expect(provider.publishAssets(DRAFT_HOME, body)).rejects.toThrow(/cannot hold attachments/)
    expect(await provider.assignees(DRAFT_HOME)).toEqual([])
    expect(graphqlCalls).toHaveLength(0)
  })

  test('remove deletes the item from its Project', async () => {
    const { run, graphqlCalls } = fakeGithub(() => ({ deleteProjectV2Item: { deletedItemId: 'PVTI_draft' } }))
    await new GitHubTaskProvider(run).remove(DRAFT_HOME)
    expect(graphqlCalls[0]?.query).toContain('deleteProjectV2Item')
    expect(graphqlCalls[0]?.variables).toEqual({ projectId: 'PVT_1', itemId: 'PVTI_draft' })
  })
})

describe('a GitHub repository source', () => {
  test('has the columns Open and Closed, and reads open issues before closed issues', async () => {
    // WHY: the list is capped. The recently closed issues of a busy repository
    // must not push open work out of it.
    const { run, graphqlCalls } = fakeGithub(({ variables }) => ({
      repository: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: variables.states?.toString() === 'OPEN'
            ? [issueNode({ parent: { number: 3, title: 'Release 2.0', url: 'https://github.com/acme/app/issues/3' } })]
            : [issueNode({ id: 'I_node5', number: 5, state: 'CLOSED' })],
        },
      },
    }))

    const read = await new GitHubRepoSource(run).read(REPO_SOURCE)

    expect(read.label).toBe('acme/app')
    expect(read.columns).toEqual([
      { id: 'open', name: 'Open', category: 'open' },
      { id: 'closed', name: 'Closed', category: 'done' },
    ])
    expect(read.writeState).toBeNull()
    expect(read.items.map((item) => [item.task.reference, item.columnId, item.itemId])).toEqual([
      ['acme/app#7', 'open', null],
      ['acme/app#5', 'closed', null],
    ])
    expect(graphqlCalls.map((call) => call.variables.states)).toEqual([['OPEN'], ['CLOSED']])
    expect(read.truncated).toBe(false)
    // A list holds up to 200 issues, so it names the epic without its description.
    expect(read.items[0]?.task.epic).toMatchObject({ externalId: '3', title: 'Release 2.0', body: '' })
    expect(graphqlCalls[0]?.query).not.toContain('parent { body }')
  })

  test('a connection without the `read:project` scope still reads the issues of a repository', async () => {
    // WHY: a repository source needs no Project. Its issue query also asks for
    // their board values, and GitHub refuses that whole query without
    // `read:project`. The source then showed "Reconnect" and no issue at all.
    const scopeError = Object.assign(new Error('Your token has not been granted the required scopes'), {
      errors: [{ type: 'INSUFFICIENT_SCOPES' }],
    })
    const { run, graphqlCalls } = fakeGithub(({ query, variables }) => {
      if (query.includes('projectItems')) throw scopeError
      const { projectItems: _withoutBoards, ...plainIssue } = issueNode()
      return {
        repository: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: variables.states?.toString() === 'OPEN' ? [plainIssue] : [],
          },
        },
      }
    })

    const read = await new GitHubRepoSource(run).read(REPO_SOURCE)

    expect(read.items.map((item) => item.task.reference)).toEqual(['acme/app#7'])
    // Without board values the issue is off every board: no priority or due date write.
    expect(read.items[0]?.task.writableFields).toEqual(['title', 'body', 'labels', 'assignee'])
    expect(graphqlCalls.filter((call) => !call.query.includes('projectItems'))).toHaveLength(2)
  })

  test('a failure that is not the missing scope is not read again without the board values', async () => {
    const { run, graphqlCalls } = fakeGithub(() => { throw new Error('GitHub is down') })
    await expect(new GitHubRepoSource(run).read(REPO_SOURCE)).rejects.toThrow('GitHub is down')
    expect(graphqlCalls).toHaveLength(1)
  })

  test('stops at the cap and says that the repository holds more', async () => {
    let page = 0
    const { run } = fakeGithub(() => {
      page += 1
      return {
        repository: {
          issues: {
            pageInfo: { hasNextPage: true, endCursor: `c${page}` },
            nodes: Array.from({ length: 50 }, (_, index) => issueNode({ id: `I_${page}_${index}`, number: page * 100 + index })),
          },
        },
      }
    })

    const read = await new GitHubRepoSource(run).read(REPO_SOURCE)

    expect(read.items).toHaveLength(MAX_SOURCE_TASKS)
    expect(read.truncated).toBe(true)
  })

  test('a move to Closed closes the issue, and an unknown column is refused', async () => {
    const { run, restCalls } = fakeGithub(
      () => ({ repository: { issue: issueNode() } }),
      { update: () => ({}) },
    )
    const source = new GitHubRepoSource(run)
    const move = { source: REPO_SOURCE, writeState: null, home: ISSUE_HOME, itemId: null, current: CURRENT }

    const task = await source.move({ ...move, columnId: 'closed' })
    expect(restCalls[0]?.params).toMatchObject({ issue_number: 7, state: 'closed' })
    expect(task?.state.category).toBe('done')

    await expect(source.move({ ...move, columnId: 'opt_doing' })).rejects.toThrow(/Open and Closed only/)
    expect(restCalls).toHaveLength(1)
  })

  test('create answers the new issue from the write, with its node id', async () => {
    // WHY: a GraphQL read immediately after the create can miss the issue.
    const { run, graphqlCalls, restCalls } = fakeGithub(() => ({}), {
      create: (params) => ({
        node_id: 'I_new',
        number: 12,
        title: params.title,
        body: params.body,
        state: 'open',
        html_url: 'https://github.com/acme/app/issues/12',
        labels: [{ name: 'bug' }],
        assignee: { login: 'ada', avatar_url: 'https://avatars/ada' },
        created_at: '2026-08-05T10:00:00Z',
        updated_at: '2026-08-05T10:00:00Z',
      }),
    })

    const item = await new GitHubRepoSource(run).create({
      source: REPO_SOURCE,
      writeState: null,
      draft: { title: 'New work', body: 'Why', labels: ['bug'], assignee: 'ada' },
    })

    expect(restCalls[0]?.params).toEqual({ owner: 'acme', repo: 'app', title: 'New work', body: 'Why', labels: ['bug'], assignees: ['ada'] })
    expect(issueKey(item.task.ref)).toBe('github:I_new')
    expect(item.task.reference).toBe('acme/app#12')
    expect(item.columnId).toBe('open')
    expect(graphqlCalls).toHaveLength(0)
  })

  test('search asks GitHub, in the repository, for issues only', async () => {
    // WHY: a filter of the capped list answers "not found" for an older issue.
    const { run, restCalls } = fakeGithub(() => { throw previewError }, {
      issuesAndPullRequests: () => ({
        total_count: 1,
        items: [{
          node_id: 'I_old',
          number: 2,
          title: 'Payment retry',
          body: null,
          state: 'closed',
          html_url: 'https://github.com/acme/app/issues/2',
          labels: ['p0', { name: 'bug' }],
          assignee: null,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-02-01T00:00:00Z',
        }],
      }),
    })

    const tasks = await new GitHubRepoSource(run).search(REPO_SOURCE, 'payment retry')

    expect(restCalls[0]?.params.q).toBe('repo:acme/app is:issue payment retry')
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      ref: { provider: 'github', id: 'I_old' },
      reference: 'acme/app#2',
      state: { name: 'Closed', category: 'done' },
      labels: ['p0', 'bug'],
      priority: 'urgent',
      writableFields: ['title', 'body', 'labels', 'assignee'],
    })
  })

  test('refuses a source of another kind', async () => {
    const { run, graphqlCalls } = fakeGithub(() => ({}))
    await expect(new GitHubRepoSource(run).read(PROJECT_SOURCE)).rejects.toThrow(/github-project/)
    expect(graphqlCalls).toHaveLength(0)
  })
})

describe('a GitHub Project source', () => {
  const items = [
    { id: 'PVTI_issue', fieldValues: { nodes: [statusValue('opt_doing', 'In progress')] }, content: issueNode() },
    { id: 'PVTI_draft', fieldValues: { nodes: [] }, content: draftNode() },
    { id: 'PVTI_pr', fieldValues: { nodes: [statusValue('opt_done', 'Done')] }, content: { __typename: 'PullRequest' } },
    { id: 'PVTI_hidden', fieldValues: { nodes: [] }, content: null },
  ]

  test('reads the board: its columns in option order, each task with its column, and what a write needs', async () => {
    // WHY: Solus shows the provider's columns in the provider's order. A
    // Status option has only a name, so the category is detected from it. A
    // pull request is not a task, and an item the viewer cannot see has no content.
    const { run, graphqlCalls } = fakeGithub(() => projectAnswer(items))

    const read = await new GitHubProjectSource(run).read(PROJECT_SOURCE)

    expect(graphqlCalls[0]?.variables).toEqual({ owner: 'acme', number: 4, cursor: null, first: 100 })
    expect(read.label).toBe('Launch board')
    expect(read.columns).toEqual([
      { id: 'opt_todo', name: 'Todo', category: 'open' },
      { id: 'opt_doing', name: 'In progress', category: 'active' },
      { id: 'opt_done', name: 'Done', category: 'done' },
    ])
    expect(read.writeState).toEqual(PROJECT_WRITE_STATE)
    expect(read.items.map((item) => [issueKey(item.task.ref), item.task.kind, item.columnId, item.itemId])).toEqual([
      ['github:I_node7', 'issue', 'opt_doing', 'PVTI_issue'],
      ['github:DI_draft1', 'draft', null, 'PVTI_draft'],
    ])
    // An issue keeps its own state: its board column is not its state.
    expect(read.items[0]?.task.state).toEqual({ name: 'Open', category: 'open' })
    expect(read.items[1]?.task.state).toEqual({ name: 'No status', category: 'open' })
    expect(read.items[1]?.task.home).toEqual(DRAFT_HOME)
    expect(read.truncated).toBe(false)
  })

  test('a Project with no Status field has no columns', async () => {
    const { run } = fakeGithub(() => {
      const answer = projectAnswer(items)
      answer.repositoryOwner.projectV2.fields.nodes.pop()
      return answer
    })
    const read = await new GitHubProjectSource(run).read(PROJECT_SOURCE)
    expect(read.columns).toEqual([])
    expect(read.writeState).toEqual({ kind: 'github-project', projectId: 'PVT_1', statusFieldId: null })
  })

  test('stops at the cap and says that the Project holds more', async () => {
    let page = 0
    const { run, graphqlCalls } = fakeGithub(() => {
      page += 1
      const nodes = Array.from({ length: 50 }, (_, index) => ({
        id: `PVTI_${page}_${index}`,
        fieldValues: { nodes: [] },
        content: draftNode(`DI_${page}_${index}`),
      }))
      return projectAnswer(nodes, { hasNextPage: true, endCursor: `cursor${page}` })
    })

    const read = await new GitHubProjectSource(run).read(PROJECT_SOURCE)

    expect(read.items).toHaveLength(MAX_SOURCE_TASKS)
    expect(read.truncated).toBe(true)
    expect(graphqlCalls.map((call) => call.variables.cursor)).toEqual([null, 'cursor1', 'cursor2', 'cursor3'])
  })

  test('a Project that GitHub does not give is a no-access failure', async () => {
    // WHY: the source settings then say "cannot read", not a generic error.
    for (const answer of [{ repositoryOwner: null }, { repositoryOwner: { projectV2: null } }]) {
      const { run } = fakeGithub(() => answer)
      const read = new GitHubProjectSource(run).read(PROJECT_SOURCE)
      await expect(read).rejects.toBeInstanceOf(TaskProviderError)
      await expect(read).rejects.toMatchObject({
        health: 'no_access',
        message: 'GitHub Project acme/4 does not exist, or this GitHub connection cannot read it.',
      })
    }
  })

  test('a missing `project` scope passes unchanged, so the caller can classify it', async () => {
    const scopeError = Object.assign(new Error('Your token has not been granted the required scopes'), {
      errors: [{ type: 'INSUFFICIENT_SCOPES' }],
    })
    const { run } = fakeGithub(() => { throw scopeError })
    await expect(new GitHubProjectSource(run).read(PROJECT_SOURCE)).rejects.toBe(scopeError)
  })

  test('search keeps the tasks whose title or reference holds the query', async () => {
    const { run } = fakeGithub(() => projectAnswer(items))
    const source = new GitHubProjectSource(run)
    expect((await source.search(PROJECT_SOURCE, 'SKETCH')).map((task) => task.title)).toEqual(['Sketch the flow'])
    expect((await source.search(PROJECT_SOURCE, 'app#7')).map((task) => task.reference)).toEqual(['acme/app#7'])
  })

  test('create adds a draft item, then sets its Status to the column', async () => {
    // WHY: a new task of a Project is a draft item, and its column is a write
    // to the Status field of the item, with the option id.
    const { run, graphqlCalls } = fakeGithub(({ query }) => {
      if (query.includes('user(login')) return { user: { id: 'U_ada' } }
      if (query.includes('addProjectV2DraftIssue')) {
        return { addProjectV2DraftIssue: { projectItem: { id: 'PVTI_draft', content: draftNode() } } }
      }
      if (query.includes('updateProjectV2ItemFieldValue')) return {}
      return {
        node: {
          id: 'PVTI_draft',
          project: { id: 'PVT_1' },
          fieldValues: { nodes: [statusValue('opt_doing', 'In progress')] },
          content: draftNode(),
        },
      }
    })

    const item = await new GitHubProjectSource(run).create({
      source: PROJECT_SOURCE,
      writeState: PROJECT_WRITE_STATE,
      draft: { title: 'Sketch the flow', body: 'Rough notes', assignee: 'ada', columnId: 'opt_doing' },
    })

    const add = graphqlCalls.find((call) => call.query.includes('addProjectV2DraftIssue'))
    expect(add?.variables).toEqual({ projectId: 'PVT_1', title: 'Sketch the flow', body: 'Rough notes', assigneeIds: ['U_ada'] })
    const place = graphqlCalls.find((call) => call.query.includes('updateProjectV2ItemFieldValue'))
    expect(place?.variables).toEqual({
      projectId: 'PVT_1',
      itemId: 'PVTI_draft',
      fieldId: 'FIELD_status',
      value: { singleSelectOptionId: 'opt_doing' },
    })
    expect(item.itemId).toBe('PVTI_draft')
    expect(item.columnId).toBe('opt_doing')
    expect(issueKey(item.task.ref)).toBe('github:DI_draft1')
    expect(item.task.state).toEqual({ name: 'In progress', category: 'active' })
  })

  test('create and move fail before a write when Solus has not read the Project', async () => {
    const { run, graphqlCalls } = fakeGithub(() => ({}))
    const source = new GitHubProjectSource(run)
    await expect(source.create({ source: PROJECT_SOURCE, writeState: null, draft: { title: 'x' } }))
      .rejects.toThrow(/has not read this GitHub Project/)
    await expect(source.move({ source: PROJECT_SOURCE, writeState: PROJECT_WRITE_STATE, home: ISSUE_HOME, itemId: null, columnId: 'opt_done', current: CURRENT }))
      .rejects.toThrow(/not an item of the GitHub Project/)
    await expect(source.move({
      source: PROJECT_SOURCE,
      writeState: { kind: 'github-project', projectId: 'PVT_1', statusFieldId: null },
      home: ISSUE_HOME,
      itemId: 'PVTI_issue',
      columnId: 'opt_done',
      current: CURRENT,
    })).rejects.toThrow(/no Status field/)
    expect(graphqlCalls).toHaveLength(0)
  })

  test('a move writes the Status option of the board item and changes no task', async () => {
    // WHY: the column of a Project is a placement. The issue stays open, so
    // the adapter answers no task.
    const { run, graphqlCalls, restCalls } = fakeGithub(() => ({}))

    const moved = await new GitHubProjectSource(run).move({
      source: PROJECT_SOURCE,
      writeState: PROJECT_WRITE_STATE,
      home: ISSUE_HOME,
      itemId: 'PVTI_issue',
      columnId: 'opt_done',
      current: CURRENT,
    })

    expect(moved).toBeNull()
    expect(graphqlCalls).toHaveLength(1)
    expect(graphqlCalls[0]?.query).toContain('updateProjectV2ItemFieldValue')
    expect(graphqlCalls[0]?.variables).toEqual({
      projectId: 'PVT_1',
      itemId: 'PVTI_issue',
      fieldId: 'FIELD_status',
      value: { singleSelectOptionId: 'opt_done' },
    })
    expect(restCalls).toHaveLength(0)
  })
})

test('repository continuation starts after the last retained page, without losing issues', async () => {
  const github = fakeGithub(({ variables }) => {
    const previous = typeof variables.cursor === 'string' ? Number(variables.cursor) : 0
    return { repository: { issues: { nodes: [issueNode({ id: `I_${previous + 1}`, number: previous + 1 })], pageInfo: { hasNextPage: previous < 4, endCursor: String(previous + 1) } } } }
  })
  const source = new GitHubRepoSource(github.run)
  const first = await source.read({ kind: 'github-repo', owner: 'acme', repo: 'app' })
  expect(first.items.map((item) => item.task.ref.id)).toEqual(['I_1', 'I_2', 'I_3', 'I_4'])
  expect(github.graphqlCalls).toHaveLength(4)
  expect(JSON.parse(first.nextCursor!)).toEqual({ state: 'OPEN', cursor: '4' })
})

test('a repository read asks each page for no more than the cap leaves', async () => {
  // WHY: a page cut at the cap would leave its other issues behind its cursor,
  // and the next page would never show them.
  const github = fakeGithub(({ variables }) => {
    const count = Number(variables.first)
    const open = variables.states instanceof Array && variables.states[0] === 'OPEN'
    const nodes = Array.from({ length: open ? 30 : count }, (_, index) => issueNode({ id: `I_${String(variables.cursor)}_${index}` }))
    return { repository: { issues: { nodes, pageInfo: { hasNextPage: !open, endCursor: 'next' } } } }
  })
  const read = await new GitHubRepoSource(github.run).read(REPO_SOURCE)
  expect(github.graphqlCalls.map((call) => call.variables.first)).toEqual([100, 100, 70])
  expect(read.items).toHaveLength(MAX_SOURCE_TASKS)
  expect(read.truncated).toBe(true)
})

test('writing multiple assignees answers the complete written set', async () => {
  const github = fakeGithub(() => ({ repository: { issue: issueNode() } }), { update: () => ({}) })
  const provider = new GitHubTaskProvider(github.run)
  const task = await provider.update({ provider: 'github', kind: 'issue', owner: 'acme', repo: 'app', number: 7 }, { assignees: ['ada', 'grace'] }, issueToTask(issueNode()))
  expect(github.restCalls[0]?.params.assignees).toEqual(['ada', 'grace'])
  expect(task.assignees?.map((person) => person.login)).toEqual(['ada', 'grace'])
})


test('authored and assigned task searches remain distinct for repositories and Projects', async () => {
  const { run, restCalls } = fakeGithub(() => { throw previewError }, { issuesAndPullRequests: () => ({ items: [] }) })
  for (const [source, adapter] of [[REPO_SOURCE, new GitHubRepoSource(run)], [PROJECT_SOURCE, new GitHubProjectSource(run)]] as const) {
    await adapter.search(source, 'fix', 'authored')
    expect(restCalls.at(-1)?.params.q).toContain('author:@me')
    await adapter.search(source, 'fix', 'assigned')
    expect(restCalls.at(-1)?.params.q).toContain('assignee:@me')
    expect(restCalls.at(-1)?.params.q).not.toContain('author:@me')
  }
})

const PLANNING_STATUSES = [
  { id: 'PS_backlog', name: 'Backlog', category: { key: 'backlog', state: 'OPEN', stateReason: null } },
  { id: 'PS_review', name: 'In review', category: { key: 'started', state: 'OPEN', stateReason: null } },
  { id: 'PS_duplicate', name: 'Duplicate', category: { key: 'duplicate', state: 'CLOSED', stateReason: 'DUPLICATE' } },
]

test('repository columns use GitHub planning status IDs, order and categories', async () => {
  const { run } = fakeGithub(({ variables }) => ({
    repository: {
      planningStatuses: { nodes: PLANNING_STATUSES },
      issues: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: variables.states?.toString() === 'OPEN' ? [issueNode({ status: PLANNING_STATUSES[1] })] : [],
      },
    },
  }))

  const read = await new GitHubRepoSource(run).read(REPO_SOURCE)
  expect(read.columns.map(({ id, name, category }) => [id, name, category])).toEqual([
    ['PS_backlog', 'Backlog', 'open'],
    ['PS_review', 'In review', 'active'],
    ['PS_duplicate', 'Duplicate', 'done'],
  ])
  expect(read.items[0]).toMatchObject({ columnId: 'PS_review', task: { state: { name: 'In review', category: 'active' } } })
})

test('issue details advertise planning statuses and GitHub controls who can use them', async () => {
  let canSetStatus = false
  const { run, graphqlCalls, restCalls } = fakeGithub(({ query }) => {
    if (query.includes('mutation SetIssueStatus')) return {}
    const issue = issueNode({
      repository: { owner: { login: 'acme' }, name: 'app', planningStatuses: { nodes: PLANNING_STATUSES } },
      status: PLANNING_STATUSES[1],
      viewerCanSetStatus: canSetStatus,
    })
    return { node: issue, repository: { issue } }
  }, { update: () => ({}) })
  const provider = new GitHubTaskProvider(run)
  const details = await provider.fetch({ provider: 'github', id: 'I_node7' })

  expect(details.statusOptions).toMatchObject({ canSetStatus: false, columns: [{ id: 'PS_backlog' }, { id: 'PS_review' }, { id: 'PS_duplicate' }] })
  await expect(provider.setNamedStatus(details.task.home, 'PS_backlog', details.task)).rejects.toThrow(/cannot change/)
  expect(graphqlCalls.some(({ query }) => query.includes('mutation SetIssueStatus'))).toBe(false)
  expect(restCalls).toHaveLength(0)

  canSetStatus = true
  const { task } = await provider.fetch({ provider: 'github', id: 'I_node7' })
  // WHY: a move read the whole issue before each write. The host copy and the
  // statuses that the read kept make each move one write.
  const reads = graphqlCalls.length
  await expect(provider.setNamedStatus(task.home, 'unknown', task)).rejects.toThrow(/no such issue status/)
  const source = new GitHubRepoSource(run)
  const moved = await source.move({ source: REPO_SOURCE, writeState: null, home: task.home, itemId: null, columnId: 'PS_backlog', current: task })
  expect(moved).toMatchObject({ stateId: 'PS_backlog', state: { name: 'Backlog', category: 'open' } })
  expect(graphqlCalls.at(-1)?.variables).toEqual({ issueId: 'I_node7', statusId: 'PS_backlog' })
  expect(graphqlCalls).toHaveLength(reads + 1)
  const duplicate = await provider.setNamedStatus(task.home, 'PS_duplicate', task)
  expect(duplicate.state).toEqual({ name: 'Duplicate', category: 'done' })
  expect(restCalls[0]?.params).toMatchObject({ issue_number: 7, state: 'closed', state_reason: 'duplicate' })
})

test('refused preview fields retry legacy issue reads with GitHub Project data', async () => {
  const project = boardItem([{ name: 'Priority', dataType: 'SINGLE_SELECT' }],
    [{ __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'High', field: { name: 'Priority' } }])
  const { run, graphqlCalls } = fakeGithub(({ query }) => {
    if (query.includes('viewerCanSetStatus')) throw previewError
    return { node: issueNode({ projectItems: { nodes: [project] } }) }
  })
  const detail = await new GitHubTaskProvider(run).fetch({ provider: 'github', id: 'I_node7' })

  expect(detail.statusOptions).toBeUndefined()
  expect(detail.task).toMatchObject({ state: { name: 'Open', category: 'open' }, priority: 'high' })
  expect(graphqlCalls).toHaveLength(2)
  expect(graphqlCalls[1]?.query).toContain('projectItems')
  expect(graphqlCalls[1]?.query).not.toContain('planningStatuses')
})

test('a connection that refused the preview fields is not asked again on the next read', async () => {
  // WHY: each read paid a refused query before the one that works. The refusal
  // is a fact about the connection, so the next read goes straight to the
  // query GitHub takes.
  const { run, graphqlCalls } = fakeGithub(({ query }) => {
    if (query.includes('viewerCanSetStatus')) throw previewError
    return { node: issueNode({}) }
  })
  const provider = new GitHubTaskProvider(run)
  await provider.fetch({ provider: 'github', id: 'I_node7' })
  expect(graphqlCalls).toHaveLength(2)

  await provider.fetch({ provider: 'github', id: 'I_node7' })
  expect(graphqlCalls).toHaveLength(3)
  expect(graphqlCalls[2]?.query).not.toContain('viewerCanSetStatus')
})

test('GitHub search returns named statuses and keeps the search qualifiers', async () => {
  const { run, graphqlCalls, restCalls } = fakeGithub(() => ({
    search: { nodes: [null, {}, issueNode({ status: PLANNING_STATUSES[1] })] },
  }))
  const results = await new GitHubRepoSource(run).search(REPO_SOURCE, 'payment', 'assigned')
  expect(results).toHaveLength(1)
  expect(results[0]?.state).toEqual({ name: 'In review', category: 'active' })
  expect(graphqlCalls[0]?.variables.query).toBe('repo:acme/app is:issue assignee:@me payment sort:updated-desc')
  expect(restCalls).toHaveLength(0)
})

test('a new issue can start in the repository column chosen in the composer', async () => {
  const { run, graphqlCalls, restCalls } = fakeGithub(({ query }) => {
    if (query.includes('mutation SetIssueStatus')) return {}
    return { repository: { planningStatuses: { nodes: PLANNING_STATUSES } } }
  }, {
    create: () => ({
      node_id: 'I_created', number: 8, title: 'Work', state: 'open', html_url: 'https://github.com/acme/app/issues/8',
      labels: [], created_at: '2026-07-30T10:00:00Z', updated_at: '2026-07-30T10:00:00Z',
    }),
  })
  const source = new GitHubRepoSource(run)
  const create = { source: REPO_SOURCE, writeState: null, draft: { title: 'Work', columnId: 'PS_review' } }
  const item = await source.create(create)
  expect(item).toMatchObject({ columnId: 'PS_review', task: { state: { name: 'In review', category: 'active' } } })
  expect(graphqlCalls.at(-1)?.variables).toEqual({ issueId: 'I_created', statusId: 'PS_review' })

  await expect(source.create({ ...create, draft: { title: 'Work', columnId: 'missing' } })).rejects.toThrow(/no such issue status/)
  expect(restCalls).toHaveLength(1)
})
