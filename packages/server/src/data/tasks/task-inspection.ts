import { connectedSite } from '../../atlassian/api'
import { linearConnection } from './providers/linear-api'
import { taskKey } from '@solus/contracts/task-sources'
import { serializeTaskWrite } from './task-writes'
import {
  inspectLinearIssue,
  reactToLinearIssue,
  linearTemplates
} from './providers/linear-inspection'
import { z } from 'zod'
import { parseTaskKey, type TaskSource } from '@solus/contracts/task-sources'
import type {
  TaskExternalIssue,
  TaskProviderData,
  TaskProviderEvent,
  TaskReactionContent,
  TaskTemplate
} from '@solus/contracts/task-data'
import { githubRun, jiraTransport, taskAdapters } from './providers/registry'
import { githubIssueDetails, readIssueNode } from './providers/github'
import type { ProviderTaskDetails } from './providers/types'
import { getTask } from './task'
import type { RecordScope } from '../../admission/principal'
import { emitChanged } from './task-store'

const reactionContent = z.enum([
  'THUMBS_UP',
  'THUMBS_DOWN',
  'LAUGH',
  'HOORAY',
  'CONFUSED',
  'HEART',
  'ROCKET',
  'EYES'
])
const reactionGroup = z.object({
  content: reactionContent,
  viewerHasReacted: z.boolean(),
  users: z.object({ totalCount: z.number() })
})
const reactionTarget = z.object({ id: z.string(), reactionGroups: z.array(reactionGroup) })
const eventSchema = z.object({
  __typename: z.string(),
  id: z.string(),
  createdAt: z.string(),
  actor: z.object({ login: z.string() }).nullish(),
  label: z.object({ name: z.string() }).nullish(),
  assignee: z.object({ login: z.string().optional() }).nullish(),
  previousTitle: z.string().nullish(),
  currentTitle: z.string().nullish(),
  milestoneTitle: z.string().nullish(),
  commit: z.object({
    abbreviatedOid: z.string(),
    commitUrl: z.string(),
    messageHeadline: z.string()
  }).nullish(),
  source: z
    .object({
      __typename: z.string(),
      url: z.string().optional(),
      number: z.number().optional(),
      title: z.string().optional(),
      state: z.string().optional(),
      closingIssuesReferences: z.object({ nodes: z.array(z.object({ id: z.string() })) }).optional()
    })
    .nullish()
})
const githubInspectionSchema = z.object({
  node: z
    .object({
      __typename: z.literal('Issue'),
      id: z.string(),
      author: z.object({ login: z.string() }).nullable(),
      assignees: z.object({
        nodes: z.array(z.object({ login: z.string(), avatarUrl: z.string() }))
      }),
      reactionGroups: z.array(reactionGroup),
      comments: z.object({
        nodes: z.array(reactionTarget),
        pageInfo: z.object({ hasNextPage: z.boolean() })
      }),
      timelineItems: z.object({
        pageInfo: z.object({ hasPreviousPage: z.boolean(), startCursor: z.string().nullable() }),
        nodes: z.array(eventSchema.nullable())
      })
    })
    .nullable()
})

const INSPECTION_QUERY = `query($id: ID!, $before: String) {
  node(id: $id) { __typename ... on Issue {
    id author { login } assignees(first: 100) { nodes { login avatarUrl } }
    reactionGroups { content viewerHasReacted users { totalCount } }
    comments(first: 100) { nodes { id reactionGroups { content viewerHasReacted users { totalCount } } } pageInfo { hasNextPage } }
    timelineItems(last: 50, before: $before, itemTypes: [CLOSED_EVENT, REOPENED_EVENT, LABELED_EVENT, UNLABELED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT, RENAMED_TITLE_EVENT, CROSS_REFERENCED_EVENT, REFERENCED_EVENT, MILESTONED_EVENT, DEMILESTONED_EVENT, LOCKED_EVENT, UNLOCKED_EVENT]) {
      pageInfo { hasPreviousPage startCursor }
      nodes {
        __typename
        ... on ClosedEvent { id createdAt actor { login } }
        ... on ReopenedEvent { id createdAt actor { login } }
        ... on LabeledEvent { id createdAt actor { login } label { name } }
        ... on UnlabeledEvent { id createdAt actor { login } label { name } }
        ... on AssignedEvent { id createdAt actor { login } assignee { ... on User { login } } }
        ... on UnassignedEvent { id createdAt actor { login } assignee { ... on User { login } } }
        ... on RenamedTitleEvent { id createdAt actor { login } previousTitle currentTitle }
        ... on ReferencedEvent { id createdAt actor { login } commit { abbreviatedOid commitUrl messageHeadline } }
        ... on MilestonedEvent { id createdAt actor { login } milestoneTitle }
        ... on DemilestonedEvent { id createdAt actor { login } milestoneTitle }
        ... on LockedEvent { id createdAt actor { login } }
        ... on UnlockedEvent { id createdAt actor { login } }
        ... on CrossReferencedEvent { id createdAt actor { login } source {
          __typename
          ... on Issue { url number title }
          ... on PullRequest { url number title state closingIssuesReferences(first: 100) { nodes { id } } }
        } }
      }
    }
  } }
}`

const emptyInspection = (reason: string): TaskProviderData => ({
  author: null,
  assignees: [],
  reactions: [],
  events: [],
  historyCursor: null,
  pullRequests: [],
  capabilities: { history: false, reactions: false, multipleAssignees: false, templates: false },
  unavailableReason: reason
})

export async function inspectTask(taskId: string, cursor?: string): Promise<TaskProviderData> {
  const ref = parseTaskKey(taskId)
  if (!ref) throw new Error('Invalid task key.')
  if (cursor && cursor.length > 4096) throw new Error('Invalid history cursor.')
  if (ref.provider === 'linear') return inspectLinearIssue(ref.workspaceId, ref.id, cursor)
  if (ref.provider === 'github')
    return githubRun('inspect_github_task', async ({ graphql }) => {
      const answer = await graphql(INSPECTION_QUERY, { id: ref.id, before: cursor ?? null })
      const kind = z.object({ node: z.object({ __typename: z.string() }).nullable() }).parse(answer)
        .node?.__typename
      if (kind && kind !== 'Issue')
        return emptyInspection('Draft items do not expose provider history or reactions.')
      const { node } = githubInspectionSchema.parse(answer)
      if (!node) throw new Error('This issue is unavailable to your GitHub connection.')
      const events = node.timelineItems.nodes.flatMap((event) => event ? githubIssueEvent(event) ?? [] : [])
      return {
        commentsTruncated: node.comments.pageInfo.hasNextPage,
        author: node.author?.login ?? null,
        assignees: node.assignees.nodes,
        reactions: [
          { id: node.id, reactionGroups: node.reactionGroups },
          ...node.comments.nodes
        ].flatMap((target) =>
          target.reactionGroups.map((group) => ({
            targetId: target.id,
            content: group.content,
            count: group.users.totalCount,
            viewerHasReacted: group.viewerHasReacted
          }))
        ),
        events,
        historyCursor: node.timelineItems.pageInfo.hasPreviousPage
          ? node.timelineItems.pageInfo.startCursor
          : null,
        pullRequests: node.timelineItems.nodes.flatMap((event) => {
          const pr = event?.source
          if (pr?.__typename !== 'PullRequest' || !pr.url || pr.number === undefined || !pr.title)
            return []
          return [
            {
              url: pr.url,
              number: pr.number,
              title: pr.title,
              state:
                pr.state === 'MERGED'
                  ? ('merged' as const)
                  : pr.state === 'CLOSED'
                    ? ('closed' as const)
                    : ('open' as const),
              closesIssue:
                pr.closingIssuesReferences?.nodes.some((issue) => issue.id === ref.id) ?? false
            }
          ]
        }),
        capabilities: { history: true, reactions: true, multipleAssignees: true, templates: true }
      }
    })
  const answer = await taskAdapters().provider(ref.provider).fetch(ref)
  if (answer.task.home.provider !== 'jira')
    return emptyInspection('Provider history is unavailable for this task.')
  const home = answer.task.home
  const startAt = cursor ? z.coerce.number().int().nonnegative().parse(cursor) : 0
  const page = await jiraTransport.request(
    {
      cloudId: home.cloudId,
      path: `/rest/api/3/issue/${encodeURIComponent(home.key)}/changelog`,
      query: { startAt: String(startAt), maxResults: '50' }
    },
    z.object({
      startAt: z.number(),
      maxResults: z.number(),
      total: z.number(),
      values: z.array(
        z.object({
          id: z.string(),
          created: z.string(),
          author: z.object({ displayName: z.string() }).nullish(),
          items: z.array(
            z.object({
              field: z.string(),
              fromString: z.string().nullish(),
              toString: z.string().nullish()
            })
          )
        })
      )
    })
  )
  return {
    ...emptyInspection('Jira supports one assignee and has no issue reactions.'),
    commentsTruncated: answer.commentsTruncated,
    assignees: answer.task.assignee
      ? [{ login: answer.task.assignee, avatarUrl: answer.task.assigneeAvatarUrl }]
      : [],
    events: page.values.flatMap((change) =>
      change.items.map((item, index) => ({
        id: `${change.id}:${index}`,
        at: Date.parse(change.created),
        actor: change.author?.displayName ?? null,
        text: `changed ${item.field} from “${item.fromString ?? 'none'}” to “${item.toString ?? 'none'}”`
      }))
    ),
    historyCursor:
      page.startAt + page.values.length < page.total
        ? String(page.startAt + page.values.length)
        : null,
    capabilities: { history: true, reactions: false, multipleAssignees: false, templates: false }
  }
}

export function githubIssueEvent(event: z.infer<typeof eventSchema>): TaskProviderEvent | null {
  const texts = {
    ClosedEvent: 'closed the issue',
    ReopenedEvent: 'reopened the issue',
    LabeledEvent: `added label ${event.label?.name ?? ''}`,
    UnlabeledEvent: `removed label ${event.label?.name ?? ''}`,
    AssignedEvent: event.assignee?.login === event.actor?.login && event.actor?.login
      ? 'self-assigned this issue' : `assigned ${event.assignee?.login ?? 'an account'}`,
    UnassignedEvent: `unassigned ${event.assignee?.login ?? 'an account'}`,
    RenamedTitleEvent: `changed the title from “${event.previousTitle ?? ''}” to “${event.currentTitle ?? ''}”`,
    CrossReferencedEvent: event.source?.url ? 'referenced this issue from' : 'referenced this issue',
    ReferencedEvent: 'added a commit that references this issue',
    MilestonedEvent: `added this issue to milestone ${event.milestoneTitle ?? ''}`,
    DemilestonedEvent: `removed this issue from milestone ${event.milestoneTitle ?? ''}`,
    LockedEvent: 'locked the conversation',
    UnlockedEvent: 'unlocked the conversation'
  }
  const text = Object.entries(texts).find(([kind]) => kind === event.__typename)?.[1]
  if (!text) return null
  const commit = event.commit
  const source = event.source
  const link = commit
    ? { url: commit.commitUrl, label: `${commit.messageHeadline} (${commit.abbreviatedOid})` }
    : source?.url && source.title ? { url: source.url, label: source.title } : undefined
  return { id: event.id, at: Date.parse(event.createdAt), actor: event.actor?.login ?? null, text, ...(link && { link }) }
}

/** Verify a reaction target belongs to this issue before sending the mutation. */
export function reactToTask(
  taskId: string,
  targetId: string,
  content: TaskReactionContent,
  add: boolean
): Promise<void> {
  return serializeTaskWrite(taskId, () => reactToTaskNow(taskId, targetId, content, add))
}
async function reactToTaskNow(
  taskId: string,
  targetId: string,
  content: TaskReactionContent,
  add: boolean
): Promise<void> {
  const ref = parseTaskKey(taskId)
  z.string().min(1).max(256).parse(targetId)
  z.boolean().parse(add)
  if (ref?.provider === 'linear') {
    reactionContent.parse(content)
    await reactToLinearIssue(ref.workspaceId, ref.id, targetId, content, add)
    emitChanged(taskId)
    return
  }
  if (ref?.provider !== 'github') throw new Error('This provider does not support issue reactions.')
  reactionContent.parse(content)
  await githubRun('react_to_github_task', async ({ graphql }) => {
    const { node } = z
      .object({
        node: z
          .object({
            __typename: z.string(),
            id: z.string(),
            issue: z.object({ id: z.string() }).optional()
          })
          .nullable()
      })
      .parse(
        await graphql(
          'query($id: ID!) { node(id: $id) { __typename id ... on IssueComment { issue { id } } } }',
          { id: targetId }
        )
      )
    if (
      !node ||
      !(
        (node.__typename === 'Issue' && node.id === ref.id) ||
        (node.__typename === 'IssueComment' && node.issue?.id === ref.id)
      )
    )
      throw new Error('This reaction target does not belong to the issue.')
    const mutation = add ? 'addReaction' : 'removeReaction'
    await graphql(
      `mutation($subjectId: ID!, $content: ReactionContent!) { ${mutation}(input: { subjectId: $subjectId, content: $content }) { subject { id } } }`,
      { subjectId: targetId, content }
    )
  })
  emitChanged(taskId)
}

export async function taskTemplates(source: TaskSource): Promise<TaskTemplate[]> {
  if (source.kind === 'linear-team')
    return linearTemplates(source.workspaceId, source.teamId, source.teamKey)
  if (source.kind !== 'github-repo') return []
  return githubRun('list_github_issue_templates', async ({ graphql, rest }) => {
    const answer = z
      .object({
        repository: z
          .object({
            issueTemplates: z
              .array(
                z.object({
                  name: z.string(),
                  filename: z.string(),
                  about: z.string().nullish(),
                  title: z.string().nullish(),
                  body: z.string().nullish(),
                  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }).nullish(),
                  assignees: z.object({ nodes: z.array(z.object({ login: z.string() })) })
                })
              )
              .nullish()
          })
          .nullable()
      })
      .parse(
        await graphql(
          'query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { issueTemplates { name filename about title body labels(first: 100) { nodes { name } } assignees(first: 100) { nodes { login } } } } }',
          source
        )
      )
    const templates: TaskTemplate[] = (answer.repository?.issueTemplates ?? []).map((template) => ({
      id: template.filename,
      name: template.name,
      description: template.about ?? '',
      title: template.title ?? '',
      body: template.body ?? '',
      labels: template.labels?.nodes.map((label) => label.name) ?? [],
      assignees: template.assignees.nodes.map((person) => person.login)
    }))
    try {
      const { data } = await rest.repos.getContent({
        owner: source.owner,
        repo: source.repo,
        path: '.github/ISSUE_TEMPLATE'
      })
      if (Array.isArray(data))
        for (const file of data) {
          if (
            file.type !== 'file' ||
            !/\.ya?ml$/i.test(file.name) ||
            /^config\.ya?ml$/i.test(file.name)
          )
            continue
          templates.push({
            id: file.name,
            name: file.name.replace(/\.ya?ml$/i, ''),
            description: 'Complete this issue form on GitHub.',
            title: '',
            body: '',
            url: `https://github.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/issues/new?template=${encodeURIComponent(file.name)}`
          })
        }
    } catch (error) {
      if (!(error instanceof Error && 'status' in error && error.status === 404)) throw error
    }
    return templates
  })
}

export async function resolveTaskUrl(
  scope: RecordScope,
  address: string,
  personKey: string,
  detailsOnly = false
): Promise<TaskExternalIssue> {
  const url = new URL(z.string().max(2048).parse(address))
  if (url.protocol !== 'https:' || url.username || url.password || url.port)
    throw new Error('Use an HTTPS issue URL without credentials or a custom port.')
  let resolved: ProviderTaskDetails
  if (url.hostname === 'github.com') {
    const match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/issues\/([1-9]\d*)\/?$/.exec(url.pathname)
    if (!match) throw new Error('This URL does not name a GitHub issue.')
    const [, owner, repo, number] = match
    resolved = await githubRun(
      'resolve_github_issue',
      async ({ graphql }) =>
        githubIssueDetails(await readIssueNode(graphql, { owner, repo, number: Number(number) }, true))
    )
  } else if (url.hostname === 'linear.app') {
    const match = /^\/([^/]+)\/issue\/([A-Za-z][A-Za-z0-9]*-[1-9]\d*)(?:\/[^/]*)?\/?$/.exec(
      url.pathname
    )
    if (!match) throw new Error('This URL does not name a Linear issue.')
    const account = await linearConnection()
    if (match[1] !== account.organization.urlKey)
      throw new Error('This URL belongs to another Linear workspace.')
    resolved = await taskAdapters()
      .provider('linear')
      .fetch({ provider: 'linear', workspaceId: account.organization.id, id: match[2] })
  } else {
    const site = await connectedSite('jira')
    if (!site || new URL(site.siteUrl).origin !== url.origin)
      throw new Error('This URL is not on a connected issue provider.')
    const match = /^\/browse\/([A-Za-z][A-Za-z0-9_]*-[1-9]\d*)\/?$/.exec(url.pathname)
    if (!match) throw new Error('This URL does not name a Jira issue.')
    resolved = await taskAdapters()
      .provider('jira')
      .fetch({ provider: 'jira', cloudId: site.cloudId, id: match[1] })
  }
  const taskId = taskKey(resolved.task.ref)
  const details = getTask(scope, taskId, personKey, resolved)
  if (detailsOnly) return { details: await details, readOnly: true }
  const [task, inspection] = await Promise.all([details, inspectTask(taskId)])
  return { details: task, inspection, readOnly: true }
}
