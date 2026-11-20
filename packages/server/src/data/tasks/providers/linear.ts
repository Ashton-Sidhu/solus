import { z } from 'zod'
import type { TaskRef, TaskSource, TaskStatusCategory } from '@solus/contracts/task-sources'
import type { TaskAssigneeCandidate, TaskUpdatePatch } from '@solus/contracts/task-types'
import type { TaskInvolvement } from '@solus/contracts/task-inspection'
import { assetReferencesIn } from '../task-assets'
import {
  linearCategory,
  linearIssueSchema,
  linearPersonSchema,
  linearRequest,
  linearStateSchema,
  LINEAR_ISSUE_FIELDS,
  type LinearInput
} from './linear-api'
import {
  MAX_SOURCE_TASKS,
  TaskProviderError,
  type ProviderTask,
  type ProviderTaskDetails,
  type SourceMove,
  type SourceRead,
  type SourceWriteState,
  type TaskDraft,
  type TaskHome,
  type TaskProviderAdapter,
  type TaskSourceAdapter
} from './types'

type LinearSource = Extract<TaskSource, { kind: 'linear-team' }>
type LinearHome = Extract<TaskHome, { provider: 'linear' }>
const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() })
const commentSchema = z.object({
  id: z.string(),
  body: z.string(),
  createdAt: z.string(),
  user: z.object({ name: z.string() }).nullish()
})
const organizationSchema = z.object({ id: z.string() })
const priorities = ['urgent', 'high', 'medium', 'low'] as const

function sourceOf(source: TaskSource): LinearSource {
  if (source.kind !== 'linear-team') throw new Error('This source is not a Linear team.')
  return source
}
function homeOf(home: TaskHome): LinearHome {
  if (home.provider !== 'linear') throw new Error('This task is not a Linear issue.')
  return home
}
function checkWorkspace(actual: string, expected: string): void {
  if (actual !== expected)
    throw new TaskProviderError(
      'no_access',
      'This Linear key belongs to another workspace. Connect the correct account.'
    )
}
function toTask(issue: z.infer<typeof linearIssueSchema>, workspaceId: string): ProviderTask {
  const assignees = issue.assignee
    ? [{ login: issue.assignee.email, avatarUrl: issue.assignee.avatarUrl ?? undefined }]
    : []
  return {
    ref: { provider: 'linear', workspaceId, id: issue.id },
    kind: 'issue',
    reference: issue.identifier,
    url: issue.url,
    title: issue.title,
    body: issue.description ?? '',
    state: { name: issue.state.name, category: linearCategory(issue.state.type) },
    stateId: issue.state.id,
    assignees,
    assignee: assignees[0]?.login,
    assigneeAvatarUrl: assignees[0]?.avatarUrl,
    labels: issue.labels.nodes.map((label) => label.name),
    priority: priorities[issue.priority - 1],
    dueDate: issue.dueDate ?? undefined,
    writableFields: ['title', 'body', 'labels', 'assignee', 'priority', 'dueDate'],
    home: { provider: 'linear', workspaceId, issueId: issue.id, teamId: issue.team.id },
    createdAt: Date.parse(issue.createdAt),
    updatedAt: Date.parse(issue.updatedAt)
  }
}
async function choices(teamId: string) {
  const answer = await linearRequest(
    'query($id: String!) { organization { id } team(id: $id) { name states { nodes { id name type position } } members(first: 100) { nodes { id name email avatarUrl } } labels(first: 100) { nodes { id name } } } }',
    { id: teamId },
    z.object({
      organization: organizationSchema,
      team: z.object({
        name: z.string(),
        states: z.object({ nodes: z.array(linearStateSchema) }),
        members: z.object({ nodes: z.array(linearPersonSchema) }),
        labels: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string() })) })
      })
    })
  )
  answer.team.states.nodes.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  return answer
}
function requestedAssignees(patch: TaskUpdatePatch): string[] | undefined {
  const assignees =
    patch.assignees ??
    (patch.assignee === undefined ? undefined : patch.assignee ? [patch.assignee] : [])
  if (assignees && assignees.length > 1) throw new Error('Linear supports one assignee per issue.')
  return assignees
}
async function writeInput(
  home: Pick<LinearHome, 'teamId' | 'workspaceId'>,
  patch: TaskUpdatePatch
): Promise<LinearInput> {
  if (assetReferencesIn(patch.body ?? '').length)
    throw new Error('Add local attachments on Linear before using them here.')
  const input: LinearInput = {}
  if (patch.title !== undefined) input.title = patch.title
  if (patch.body !== undefined) input.description = patch.body
  if (patch.priority !== undefined)
    input.priority = patch.priority ? priorities.indexOf(patch.priority) + 1 : 0
  if (patch.dueDate !== undefined) input.dueDate = patch.dueDate
  const assignees = requestedAssignees(patch)
  if (patch.labels !== undefined || assignees !== undefined) {
    const account = await choices(home.teamId)
    checkWorkspace(account.organization.id, home.workspaceId)
    if (patch.labels !== undefined)
      input.labelIds = patch.labels.map((name) => {
        const label = account.team.labels.nodes.find((candidate) => candidate.name === name)
        if (!label) throw new Error(`Linear team has no label “${name}”.`)
        return label.id
      })
    if (assignees !== undefined) {
      const assignee = account.team.members.nodes.find((person) => person.email === assignees[0])
      if (assignees.length && !assignee)
        throw new Error('This assignee is not a member of the Linear team.')
      input.assigneeId = assignee?.id ?? null
    }
  }
  return input
}
async function readIssue(
  ref: Extract<TaskRef, { provider: 'linear' }>
): Promise<ProviderTaskDetails> {
  const answer = await linearRequest(
    `query($id: String!) { organization { id } issue(id: $id) { ${LINEAR_ISSUE_FIELDS} comments(first: 100) { nodes { id body createdAt user { name } } pageInfo { hasNextPage endCursor } } } }`,
    { id: ref.id },
    z.object({
      organization: organizationSchema,
      issue: linearIssueSchema.extend({
        comments: z.object({ nodes: z.array(commentSchema), pageInfo })
      })
    })
  )
  checkWorkspace(answer.organization.id, ref.workspaceId)
  return {
    task: toTask(answer.issue, ref.workspaceId),
    comments: answer.issue.comments.nodes.map((comment) => ({
      id: comment.id,
      author: comment.user?.name ?? null,
      body: comment.body,
      createdAt: Date.parse(comment.createdAt)
    })),
    commentsTruncated: answer.issue.comments.pageInfo.hasNextPage
  }
}
async function updateIssue(home: LinearHome, input: LinearInput): Promise<ProviderTask> {
  // A fresh read proves workspace access before any mutation.
  await readIssue({ provider: 'linear', workspaceId: home.workspaceId, id: home.issueId })
  const answer = await linearRequest(
    `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { ${LINEAR_ISSUE_FIELDS} } } }`,
    { id: home.issueId, input },
    z.object({
      issueUpdate: z.object({ success: z.boolean(), issue: linearIssueSchema.nullable() })
    })
  )
  if (!answer.issueUpdate.success || !answer.issueUpdate.issue)
    throw new Error('Linear did not accept the issue change.')
  return toTask(answer.issueUpdate.issue, home.workspaceId)
}

export class LinearTaskProvider implements TaskProviderAdapter {
  readonly id = 'linear' as const
  async fetch(ref: TaskRef): Promise<ProviderTaskDetails> {
    if (ref.provider !== 'linear') throw new Error('This task is not from Linear.')
    return readIssue(ref)
  }
  async update(home: TaskHome, patch: TaskUpdatePatch): Promise<ProviderTask> {
    const target = homeOf(home)
    return updateIssue(target, await writeInput(target, patch))
  }
  async setState(home: TaskHome, category: TaskStatusCategory): Promise<ProviderTask> {
    const target = homeOf(home)
    const account = await choices(target.teamId)
    checkWorkspace(account.organization.id, target.workspaceId)
    const state = account.team.states.nodes.find(
      (candidate) => linearCategory(candidate.type) === category
    )
    if (!state) throw new Error(`This Linear team has no ${category} state.`)
    return updateIssue(target, { stateId: state.id })
  }
  async comment(home: TaskHome, body: string) {
    const target = homeOf(home)
    await readIssue({ provider: 'linear', workspaceId: target.workspaceId, id: target.issueId })
    const answer = await linearRequest(
      'mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id body createdAt user { name } } } }',
      { input: { issueId: target.issueId, body } },
      z.object({
        commentCreate: z.object({ success: z.boolean(), comment: commentSchema.nullable() })
      })
    )
    if (!answer.commentCreate.success || !answer.commentCreate.comment)
      throw new Error('Linear did not accept the comment.')
    const comment = answer.commentCreate.comment
    return {
      id: comment.id,
      author: comment.user?.name ?? null,
      body: comment.body,
      createdAt: Date.parse(comment.createdAt)
    }
  }
  async assignees(home: TaskHome): Promise<TaskAssigneeCandidate[]> {
    const target = homeOf(home),
      account = await choices(target.teamId)
    checkWorkspace(account.organization.id, target.workspaceId)
    return account.team.members.nodes.map((person) => ({
      login: person.email,
      avatarUrl: person.avatarUrl ?? undefined
    }))
  }
  async publishAssets(home: TaskHome, body: string): Promise<string> {
    homeOf(home)
    if (assetReferencesIn(body).length) throw new Error('Upload local attachments on Linear first.')
    return body
  }
  unpublishableAssets(home: TaskHome, body: string) {
    homeOf(home)
    return assetReferencesIn(body)
  }
  async remove(): Promise<void> {
    throw new Error('Close a Linear issue instead of deleting it.')
  }
}

export class LinearTeamSource implements TaskSourceAdapter {
  readonly kind = 'linear-team' as const
  async read(source: TaskSource, continuation?: string): Promise<SourceRead> {
    const team = sourceOf(source),
      account = await choices(team.teamId)
    checkWorkspace(account.organization.id, team.workspaceId)
    const answer = await linearRequest(
      `query($id: String!, $after: String) { team(id: $id) { issues(first: ${MAX_SOURCE_TASKS}, after: $after, orderBy: updatedAt) { nodes { ${LINEAR_ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } } }`,
      { id: team.teamId, after: continuation ?? null },
      z.object({
        team: z.object({ issues: z.object({ nodes: z.array(linearIssueSchema), pageInfo }) })
      })
    )
    return {
      label: `${team.teamKey} · ${account.team.name}`,
      columns: account.team.states.nodes.map((state) => ({
        id: state.id,
        name: state.name,
        category: linearCategory(state.type)
      })),
      writeState: null,
      items: answer.team.issues.nodes.map((issue) => ({
        task: toTask(issue, team.workspaceId),
        columnId: issue.state.id,
        itemId: null
      })),
      truncated: answer.team.issues.pageInfo.hasNextPage,
      nextCursor: answer.team.issues.pageInfo.hasNextPage
        ? answer.team.issues.pageInfo.endCursor
        : null
    }
  }
  async search(
    source: TaskSource,
    query: string,
    involvement: TaskInvolvement = 'all'
  ): Promise<ProviderTask[]> {
    if (involvement === 'mentioned')
      throw new Error(
        'Use Linear notifications to find mentions; this API does not expose a reliable mention filter.'
      )
    const team = sourceOf(source)
    const account = await choices(team.teamId)
    checkWorkspace(account.organization.id, team.workspaceId)
    const authored = involvement === 'authored' ? ', creator: { isMe: { eq: true } }' : involvement === 'assigned' ? ', assignee: { isMe: { eq: true } }' : ''
    const answer = await linearRequest(
      `query($id: String!, $text: String!) { team(id: $id) { issues(first: 100, filter: { title: { containsIgnoreCase: $text } ${authored} }) { nodes { ${LINEAR_ISSUE_FIELDS} } } } }`,
      { id: team.teamId, text: query },
      z.object({ team: z.object({ issues: z.object({ nodes: z.array(linearIssueSchema) }) }) })
    )
    return answer.team.issues.nodes.map((issue) => toTask(issue, team.workspaceId))
  }
  async create({
    source,
    draft
  }: {
    source: TaskSource
    writeState: SourceWriteState | null
    draft: TaskDraft
  }) {
    const team = sourceOf(source),
      account = await choices(team.teamId)
    checkWorkspace(account.organization.id, team.workspaceId)
    const input = await writeInput(team, { ...draft })
    input.teamId = team.teamId
    if (draft.columnId) {
      if (!account.team.states.nodes.some((state) => state.id === draft.columnId))
        throw new Error('This state does not belong to the Linear team.')
      input.stateId = draft.columnId
    }
    const answer = await linearRequest(
      `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${LINEAR_ISSUE_FIELDS} } } }`,
      { input },
      z.object({
        issueCreate: z.object({ success: z.boolean(), issue: linearIssueSchema.nullable() })
      })
    )
    if (!answer.issueCreate.success || !answer.issueCreate.issue)
      throw new Error('Linear did not create the issue.')
    return {
      task: toTask(answer.issueCreate.issue, team.workspaceId),
      columnId: answer.issueCreate.issue.state.id,
      itemId: null
    }
  }
  async move(input: SourceMove): Promise<ProviderTask> {
    const team = sourceOf(input.source),
      target = homeOf(input.home),
      account = await choices(team.teamId)
    checkWorkspace(account.organization.id, team.workspaceId)
    if (target.workspaceId !== team.workspaceId || target.teamId !== team.teamId)
      throw new Error('This issue belongs to another Linear team.')
    if (!account.team.states.nodes.some((state) => state.id === input.columnId))
      throw new Error('This state does not belong to the Linear team.')
    return updateIssue(target, { stateId: input.columnId })
  }
  async assignees(source: TaskSource): Promise<TaskAssigneeCandidate[]> {
    const team = sourceOf(source),
      account = await choices(team.teamId)
    checkWorkspace(account.organization.id, team.workspaceId)
    return account.team.members.nodes.map((person) => ({
      login: person.email,
      avatarUrl: person.avatarUrl ?? undefined
    }))
  }
}
