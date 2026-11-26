import { connectedSite } from '../../atlassian/api'
import { linearConnection } from './providers/linear-api'
import { issueKey } from '@solus/contracts/task-sources'
import { withTaskProviderMetadata } from '@solus/contracts/task-data'
import { serializeTaskWrite } from './task-writes'
import {
  inspectLinearIssue,
  reactToLinearIssue,
  linearTemplates
} from './providers/linear-inspection'
import { z } from 'zod'
import { parseIssueKey, type IssueSource } from '@solus/contracts/task-sources'
import type {
  TaskExternalIssue,
  TaskProviderData,
  TaskReactionContent,
  TaskTemplate
} from '@solus/contracts/task-data'
import { githubRun, jiraTransport, taskAdapters } from './providers/registry'
import { githubIssueDetails, readIssueNode } from './providers/github'
import {
  GITHUB_ISSUE_METADATA_QUERY, githubIssueIdentity, githubIssueMetadata, githubReactionContent,
  type GitHubIssueProviderSelection
} from './providers/github-issue-metadata'
import type { ProviderTaskDetails } from './providers/types'
import { getTask } from './task'
import type { RecordScope } from '../../admission/principal'
import { emitChanged, taskHomeOf } from './task-store'
import { readGithubIssueTimeline } from '../../providers/github/issue-timeline'

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

export async function inspectTask(taskId: string, cursor?: string, timelineOnly = false): Promise<TaskProviderData> {
  const ref = parseIssueKey(taskId)
  if (!ref) throw new Error('Invalid task key.')
  if (cursor && cursor.length > 4096) throw new Error('Invalid history cursor.')
  if (ref.provider === 'linear') return inspectLinearIssue(ref.workspaceId, ref.id, cursor)
  if (ref.provider === 'github')
    return githubRun('inspect_github_task', async ({ graphql, rest }) => {
      const capabilities = { history: true, reactions: true, multipleAssignees: true, templates: true }
      const home = cursor || timelineOnly ? await taskHomeOf(taskId) : null
      if (home?.provider === 'github' && home.kind === 'issue') {
        const timeline = await readGithubIssueTimeline(rest, taskId, home, cursor)
        return { ...timeline, author: null, assignees: [], reactions: [], capabilities }
      }
      const { node } = await graphql<{ node: GitHubIssueProviderSelection | null }>(GITHUB_ISSUE_METADATA_QUERY, { id: ref.id })
      if (node && node.__typename !== 'Issue')
        return emptyInspection('Draft items do not expose provider history or reactions.')
      const identity = githubIssueIdentity.safeParse(node)
      if (!node || !identity.success || !identity.data.repository || identity.data.number === undefined)
        throw new Error('This issue is unavailable to your GitHub connection.')
      const { repository, number } = identity.data
      const [timeline, metadata] = await Promise.all([
        readGithubIssueTimeline(rest, taskId, { owner: repository.owner.login, repo: repository.name, number }, cursor),
        githubIssueMetadata(node, graphql)
      ])
      const data = { ...timeline, author: null, assignees: [], reactions: [], capabilities }
      return metadata ? withTaskProviderMetadata(data, metadata) : data
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
  const ref = parseIssueKey(taskId)
  z.string().min(1).max(256).parse(targetId)
  z.boolean().parse(add)
  if (ref?.provider === 'linear') {
    githubReactionContent.parse(content)
    await reactToLinearIssue(ref.workspaceId, ref.id, targetId, content, add)
    emitChanged(taskId)
    return
  }
  if (ref?.provider !== 'github') throw new Error('This provider does not support issue reactions.')
  githubReactionContent.parse(content)
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

export async function taskTemplates(source: IssueSource): Promise<TaskTemplate[]> {
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
        githubIssueDetails(await readIssueNode(graphql, { owner, repo, number: Number(number) }, true), graphql)
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
  const taskId = issueKey(resolved.task.ref)
  const details = await getTask(scope, taskId, personKey, { resolved })
  if (detailsOnly) return { details, readOnly: true }
  const metadata = details.providerMetadata
  const timeline = await inspectTask(taskId, undefined, !!metadata)
  const inspection = metadata ? withTaskProviderMetadata(timeline, metadata) : timeline
  return { details, inspection, readOnly: true }
}
