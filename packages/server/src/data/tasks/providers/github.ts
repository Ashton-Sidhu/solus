import { issueKey, type IssueRef, type IssueStatusCategory } from '@solus/contracts/task-sources'
import type { IssueAssigneeCandidate, IssueUpdatePatch } from '@solus/contracts/task-types'
import type { GitHubClient, GraphQLParameters } from '../../../providers/github/octokit'
import {
  GITHUB_UPLOADABLE_ASSETS,
  resolveUploadTarget,
  uploadGithubAsset,
} from '../../../providers/github/asset-upload'
import { publishedAssetUrl, recordAssetPublication } from '../asset-publications'
import { readGithubIssues, readRepositoryPlanningStatuses, rememberPlanningStatuses, writePlanningStatus } from './github-planning-status'
import { githubIssueMetadata } from './github-issue-metadata'
import { assetReferencesIn, withPublishedAssets, type AssetReference } from '../task-assets'
import {
  boardItemsOf,
  commentFromNode,
  DELETE_ITEM_MUTATION,
  DRAFT_ITEM_QUERY,
  draftToTask,
  planningColumn,
  planningState,
  planningStatusesOf,
  issueState,
  issueToTask,
  priorityFromLabels,
  priorityFromOption,
  projectItemsOf,
  restIssueToTask,
  statusValueOf,
  UPDATE_DRAFT_MUTATION,
  USER_ID_QUERY,
  type DraftItemResponse,
  type DraftNode,
  type IssueByNumberResponse,
  type IssueNode,
  type TaskNodeResponse,
  type UpdateDraftResponse,
  type UserIdResponse,
} from './github-model'
import {
  TaskProviderError,
  type GitHubBoardItem,
  type GithubRun,
  type ProviderComment,
  type ProviderTask,
  type ProviderTaskDetails,
  type TaskDraft,
  type TaskHome,
  type TaskProviderAdapter,
} from './types'

type Graphql = GitHubClient['graphql']
type IssueHome = Extract<TaskHome, { provider: 'github'; kind: 'issue' }>
type DraftHome = Extract<TaskHome, { provider: 'github'; kind: 'draft' }>

function githubHome(home: TaskHome): IssueHome | DraftHome {
  if (home.provider !== 'github') throw new Error(`The GitHub task provider cannot write to a ${home.provider} task.`)
  return home
}

type IssueNumber = Pick<IssueHome, 'owner' | 'repo' | 'number'>

function issueReference(home: IssueNumber): string {
  return `${home.owner}/${home.repo}#${home.number}`
}

/** Read one issue by its number. GitHub reads follow a repository rename. */
export async function readIssueNode(graphql: Graphql, home: IssueNumber, includeComments = false): Promise<IssueNode> {
  const res = await readGithubIssues(graphql, (queries) => graphql<IssueByNumberResponse>(includeComments ? queries.issueDetailsByNumber : queries.issueByNumber, {
    owner: home.owner,
    repo: home.repo,
    number: home.number,
  }))
  const issue = res.repository?.issue
  if (!issue) {
    throw new TaskProviderError(
      'no_access',
      `GitHub issue ${issueReference(home)} does not exist, or this GitHub connection cannot read it.`,
    )
  }
  return issue
}

export async function githubIssueDetails(node: IssueNode, graphql: Graphql): Promise<ProviderTaskDetails> {
  const comments = node.comments ?? { totalCount: 0, nodes: [] }
  const task = issueToTask(node)
  // A failing closing-PR page must not hide the issue. Activity retries the metadata read.
  const providerMetadata = await githubIssueMetadata(issueKey(task.ref), node, graphql).catch(() => undefined)
  const statuses = planningStatusesOf(node.repository)
  if (node.repository.planningStatuses) {
    rememberPlanningStatuses(graphql, { owner: node.repository.owner.login, repo: node.repository.name }, statuses)
  }
  const columns = statuses.map(planningColumn)
  return {
    task,
    ...(columns.length > 0 && { statusOptions: { columns, canSetStatus: node.viewerCanSetStatus === true } }),
    comments: comments.nodes.map(commentFromNode),
    commentsTruncated: comments.totalCount > comments.nodes.length,
    ...(providerMetadata && { providerMetadata }),
  }
}

/** The draft of one board item, with the Status option the board gives it. */
export async function readDraftItem(graphql: Graphql, itemId: string): Promise<ProviderTask> {
  const res = await graphql<DraftItemResponse>(DRAFT_ITEM_QUERY, { itemId })
  const item = res.node
  const draft = item?.content
  if (!item || !draft?.id) {
    throw new TaskProviderError(
      'no_access',
      'This draft item does not exist, or this GitHub connection cannot read it.',
    )
  }
  return draftToTask(
    {
      id: draft.id,
      title: draft.title ?? '',
      body: draft.body ?? null,
      createdAt: draft.createdAt ?? '',
      updatedAt: draft.updatedAt ?? '',
      assignees: draft.assignees ?? { nodes: [] },
    },
    { projectId: item.project.id, itemId: item.id, statusName: statusValueOf(item.fieldValues)?.name ?? null },
  )
}

/** The node id of a person, which a draft takes as its assignee. */
export async function githubUserId(graphql: Graphql, login: string): Promise<string> {
  const res = await graphql<UserIdResponse>(USER_ID_QUERY, { login })
  if (!res.user) throw new Error(`GitHub has no user ${login}.`)
  return res.user.id
}

/** The people GitHub permits an issue of the repository to be assigned to. */
export function listRepoAssignees(
  run: GithubRun,
  repository: { owner: string; repo: string },
): Promise<IssueAssigneeCandidate[]> {
  return run('list_github_task_assignees', async ({ rest }) => {
    const { data } = await rest.issues.listAssignees({ owner: repository.owner, repo: repository.repo, per_page: 100 })
    return data.map((user) => ({ login: user.login, avatarUrl: user.avatar_url }))
  })
}

/** Put the fields of a write that succeeded on the task that a read gave. */
function withWrittenFields(task: ProviderTask, patch: IssueUpdatePatch, onBoard: boolean): ProviderTask {
  if (patch.title !== undefined) task.title = patch.title
  if (patch.body !== undefined) task.body = patch.body
  if (patch.labels !== undefined) {
    task.labels = patch.labels
    // On a board the priority is a board field, so a label edit must not change it.
    if (!onBoard) task.priority = priorityFromLabels(patch.labels)
  }
  if (patch.assignee !== undefined && task.assignee !== (patch.assignee ?? undefined)) {
    task.assignee = patch.assignee ?? undefined
    task.assigneeAvatarUrl = undefined
  }
  if (patch.assignees !== undefined || patch.assignee !== undefined) {
    const logins = patch.assignees ?? (patch.assignee ? [patch.assignee] : [])
    task.assignees = logins.map((login) => task.assignees?.find((person) => person.login === login) ?? { login })
    task.assignee = logins[0]
    task.assigneeAvatarUrl = task.assignees[0]?.avatarUrl
  }
  if (patch.dueDate !== undefined) task.dueDate = patch.dueDate || undefined
  if (patch.priority !== undefined) task.priority = patch.priority || undefined
  return task
}

/**
 * Create an issue and answer it as a task. The answer of the write is the
 * task: a GraphQL read immediately after a REST write can miss the new issue.
 * A new issue is open, so only `closed` needs a second write.
 */
export function createRepoIssue(
  run: GithubRun,
  repository: { owner: string; repo: string },
  draft: TaskDraft,
  closed: boolean,
  statusId?: string,
): Promise<ProviderTask> {
  return run('create_github_task', async (client) => {
    const { rest, graphql } = client
    const status = statusId
      ? (await readRepositoryPlanningStatuses(graphql, repository)).find(({ id }) => id === statusId)
      : undefined
    if (statusId && !status) throw new Error('This repository has no such issue status.')
    const base = { owner: repository.owner, repo: repository.repo }
    const created = await rest.issues.create({
      ...base,
      title: draft.title,
      body: draft.body,
      labels: draft.labels,
      assignees: draft.assignees ?? (draft.assignee ? [draft.assignee] : undefined),
    })
    const issue = closed
      ? (await rest.issues.update({ ...base, issue_number: created.data.number, state: 'closed' })).data
      : created.data
    const task = restIssueToTask(issue, base)
    if (status) {
      try {
        await writePlanningStatus(client, { ...base, number: issue.number }, task.ref.id, status)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`GitHub created ${task.reference}, but could not set its planning status. ${detail}`, { cause: error })
      }
      task.state = planningState(status)
      task.stateId = status.id
    }
    return task
  })
}

/**
 * How GitHub renders one published asset.
 *
 * A video has no Markdown syntax for a player: GitHub promotes a bare URL that
 * is the whole content of a paragraph. An SVG stays a link rather than an inline
 * image, which is the stance ADR-0015 already takes locally.
 */
function githubAssetMarkdown(reference: AssetReference, url: string): string {
  if (GITHUB_UPLOADABLE_ASSETS.get(reference.extension)?.kind === 'video') return `\n\n${url}\n\n`
  const label = reference.label || reference.assetId
  if (reference.extension === 'svg' || !reference.isImage) return `[${label}](${url})`
  return `![${label}](${url})`
}

/** One GraphQL document and its variables. */
interface BoardFieldWrite {
  query: string
  variables: GraphQLParameters
}

/**
 * The priority and due date of an issue as one aliased mutation. Each goes to
 * the first board item whose Project has its field. A field that no board item
 * has, or an option that the Priority field lacks, fails before any write.
 */
function boardFieldWrite(
  home: IssueHome,
  items: GitHubBoardItem[],
  patch: Pick<IssueUpdatePatch, 'priority' | 'dueDate'>,
): BoardFieldWrite {
  const params: string[] = []
  const fields: string[] = []
  const variables: GraphQLParameters = {}
  const write = (alias: string, item: GitHubBoardItem, fieldId: string, value?: { date: string } | { singleSelectOptionId: string }) => {
    params.push(`$${alias}Project: ID!`, `$${alias}Item: ID!`, `$${alias}Field: ID!`)
    Object.assign(variables, { [`${alias}Project`]: item.projectId, [`${alias}Item`]: item.itemId, [`${alias}Field`]: fieldId })
    const input = `projectId: $${alias}Project, itemId: $${alias}Item, fieldId: $${alias}Field`
    if (!value) {
      fields.push(`${alias}: clearProjectV2ItemFieldValue(input: { ${input} }) { projectV2Item { id } }`)
      return
    }
    params.push(`$${alias}Value: ProjectV2FieldValue!`)
    variables[`${alias}Value`] = value
    fields.push(`${alias}: updateProjectV2ItemFieldValue(input: { ${input}, value: $${alias}Value }) { projectV2Item { id } }`)
  }
  if (patch.priority !== undefined) {
    const item = items.find((candidate) => candidate.priority)
    if (!item?.priority) throw new Error(`${issueReference(home)} is on no GitHub Project with a Priority field, so it takes no priority.`)
    const option = patch.priority ? item.priority.options.find((candidate) => priorityFromOption(candidate.name) === patch.priority) : undefined
    if (patch.priority && !option) throw new Error(`The Priority field of this GitHub Project has no option for ${patch.priority}.`)
    write('priority', item, item.priority.fieldId, option && { singleSelectOptionId: option.id })
  }
  if (patch.dueDate !== undefined) {
    const item = items.find((candidate) => candidate.dueFieldId)
    if (!item?.dueFieldId) throw new Error(`${issueReference(home)} is on no GitHub Project with a date field, so it takes no due date.`)
    write('dueDate', item, item.dueFieldId, patch.dueDate ? { date: patch.dueDate } : undefined)
  }
  return { query: `mutation(${params.join(', ')}) { ${fields.join(' ')} }`, variables }
}

/**
 * GitHub issues and the draft items of GitHub Projects, read and written by
 * the task's `home`. GitHub stays the owner of the content: an issue cannot be
 * deleted from Solus.
 */
export class GitHubTaskProvider implements TaskProviderAdapter {
  readonly id = 'github' as const

  constructor(private readonly run: GithubRun) {}

  async fetch(ref: IssueRef, options?: { providerMetadata?: boolean }): Promise<ProviderTaskDetails> {
    if (ref.provider !== 'github') throw new Error(`The GitHub task provider cannot read a ${ref.provider} task.`)
    return this.run('get_github_task', async ({ graphql }) => {
      const { node } = await readGithubIssues(graphql, (queries) => graphql<TaskNodeResponse>(
        options?.providerMetadata ? queries.taskNodeWithMetadata : queries.taskNode,
        { id: ref.id }
      ))
      if (node?.__typename === 'Issue') return githubIssueDetails(node, graphql)
      const item = node?.__typename === 'DraftIssue' ? node.projectV2Items.nodes.find(Boolean) : null
      if (node?.__typename !== 'DraftIssue' || !item) {
        throw new TaskProviderError(
          'no_access',
          'This GitHub task does not exist, or this GitHub connection cannot read it.',
        )
      }
      return {
        task: draftToTask(node, {
          projectId: item.project.id,
          itemId: item.id,
          statusName: statusValueOf(item.fieldValues)?.name ?? null,
        }),
        comments: [],
        commentsTruncated: false,
      }
    })
  }

  /**
   * An issue takes its title, body, labels and assignee as issue fields. Its
   * priority and due date are fields of a Project it is on. A draft item takes
   * a title, a body and an assignee.
   */
  async update(home: TaskHome, patch: IssueUpdatePatch, current: ProviderTask): Promise<ProviderTask> {
    const target = githubHome(home)
    return target.kind === 'issue' ? this.updateIssue(target, patch, current) : this.updateDraft(target, patch, current)
  }

  private updateIssue(home: IssueHome, patch: IssueUpdatePatch, current: ProviderTask): Promise<ProviderTask> {
    return this.run('update_github_task', async ({ rest, graphql }) => {
      // The host's copy holds the board items. A copy stored before it had them
      // reads them once.
      if (patch.dueDate !== undefined || patch.priority !== undefined) {
        const items = home.boardItems ?? boardItemsOf(projectItemsOf(await readIssueNode(graphql, home)))
        const { query, variables } = boardFieldWrite(home, items, patch)
        await graphql(query, variables)
      }

      // `labels` replaces the whole set, and one assignee replaces all assignees.
      const assignees = patch.assignees ?? (patch.assignee === undefined ? undefined : patch.assignee ? [patch.assignee] : [])
      let updatedAt = Date.now()
      if (
        patch.title !== undefined || patch.body !== undefined
        || patch.labels !== undefined || assignees !== undefined
      ) {
        const { data } = await rest.issues.update({
          owner: home.owner,
          repo: home.repo,
          issue_number: home.number,
          title: patch.title,
          body: patch.body,
          labels: patch.labels,
          assignees,
        })
        updatedAt = Date.parse(data.updated_at) || updatedAt
      }

      // The writes succeeded, so the host's copy with the written fields is the
      // issue now. A read here would cost a call, and GitHub's GraphQL reads lag
      // its REST writes, so it could give the issue as it was. Only an issue on
      // a board takes a priority or a due date.
      const onBoard = current.writableFields.includes('priority') || current.writableFields.includes('dueDate')
      return { ...withWrittenFields(structuredClone(current), patch, onBoard), updatedAt }
    })
  }

  private async updateDraft(home: DraftHome, patch: IssueUpdatePatch, current: ProviderTask): Promise<ProviderTask> {
    if (patch.labels !== undefined || patch.priority !== undefined || patch.dueDate !== undefined) {
      throw new Error('A draft item of a GitHub Project takes a title, a body and an assignee only.')
    }
    return this.run('update_github_draft', async ({ graphql }) => {
      // The mutation takes the draft's id, which is the id of the host's copy.
      const logins = patch.assignees ?? (patch.assignee === undefined ? undefined : patch.assignee ? [patch.assignee] : [])
      const assigneeIds = logins === undefined ? undefined : await Promise.all(logins.map((login) => githubUserId(graphql, login)))
      const res = await graphql<UpdateDraftResponse>(UPDATE_DRAFT_MUTATION, {
        draftIssueId: current.ref.id,
        title: patch.title,
        body: patch.body,
        assigneeIds,
      })
      const draft: DraftNode = res.updateProjectV2DraftIssue.draftIssue
      return { ...draftToTask(draft, { projectId: home.projectId, itemId: home.itemId, statusName: null }), state: current.state }
    })
  }

  setState(home: TaskHome, category: IssueStatusCategory, current: ProviderTask): Promise<ProviderTask> {
    return this.moveIssue(home, { category }, current)
  }

  setNamedStatus(home: TaskHome, statusId: string, current: ProviderTask): Promise<ProviderTask> {
    return this.moveIssue(home, { statusId }, current)
  }

  /**
   * One write, answered from the host's copy: the node id, the status and the
   * permission come from the last read, and the repository's statuses from a
   * recent read (`readRepositoryPlanningStatuses`).
   */
  private async moveIssue(
    home: TaskHome,
    target: { category: IssueStatusCategory } | { statusId: string },
    current: ProviderTask,
  ): Promise<ProviderTask> {
    const issue = githubHome(home)
    if (issue.kind === 'draft') {
      throw new Error('A draft item has no state of its own. Move it on its GitHub Project.')
    }
    return this.run('set_github_task_state', async (client) => {
      const task = structuredClone(current)
      const statuses = await readRepositoryPlanningStatuses(client.graphql, issue)
      if (statuses.length || 'statusId' in target) {
        const status = statuses.find((candidate) => 'statusId' in target
          ? candidate.id === target.statusId
          : planningColumn(candidate).category === target.category)
          ?? ('category' in target && target.category === 'active'
            ? statuses.find((candidate) => planningColumn(candidate).category === 'open')
            : undefined)
        if (!status) throw new Error(statuses.length
          ? 'This repository has no such issue status.'
          : 'This repository has the columns Open and Closed only.')
        if (issue.canSetStatus === false) throw new Error('This GitHub connection cannot change the issue status.')
        if (current.stateId === status.id) return task
        await writePlanningStatus(client, issue, current.ref.id, status)
        task.state = planningState(status)
        task.stateId = status.id
        task.updatedAt = Date.now()
      } else {
        const closed = target.category === 'done'
        const { data } = await client.rest.issues.update({
          owner: issue.owner, repo: issue.repo, issue_number: issue.number, state: closed ? 'closed' : 'open',
        })
        task.state = issueState(closed ? 'CLOSED' : 'OPEN')
        task.stateId = undefined
        task.updatedAt = Date.parse(data.updated_at) || Date.now()
      }
      return task
    })
  }

  async comment(home: TaskHome, body: string): Promise<ProviderComment> {
    const target = githubHome(home)
    if (target.kind === 'draft') throw new Error('A draft item of a GitHub Project takes no comments.')
    return this.run('comment_on_github_task', async ({ rest }) => {
      const res = await rest.issues.createComment({
        owner: target.owner,
        repo: target.repo,
        issue_number: target.number,
        body,
      })
      // The node id, not the REST database id: comments are read through
      // GraphQL, whose `id` is the node id. With the REST id, the next read
      // would give this comment a second time.
      if (!res.data.node_id) throw new Error('GitHub created a comment without a node ID.')
      return {
        id: res.data.node_id,
        author: res.data.user?.login ?? null,
        body: res.data.body ?? body,
        createdAt: Date.parse(res.data.created_at) || Date.now(),
      }
    })
  }

  async assignees(home: TaskHome): Promise<IssueAssigneeCandidate[]> {
    const target = githubHome(home)
    // GitHub cannot list the people a draft can be assigned to.
    if (target.kind === 'draft') return []
    return listRepoAssignees(this.run, target)
  }

  unpublishableAssets(home: TaskHome, body: string): AssetReference[] {
    const references = assetReferencesIn(body)
    // An upload is attached to a repository, and a draft item has none.
    if (githubHome(home).kind === 'draft') return references
    return references.filter((reference) => !GITHUB_UPLOADABLE_ASSETS.has(reference.extension))
  }

  /**
   * The assets are attached to the repository of the issue, and a publication
   * is recorded for that repository: one screenshot on one repository uploads
   * once, for each comment that references it.
   */
  async publishAssets(home: TaskHome, body: string): Promise<string> {
    const target = githubHome(home)
    const references = assetReferencesIn(body)
    if (!references.length) return body
    if (target.kind === 'draft') {
      throw new Error('A draft item of a GitHub Project cannot hold attachments.')
    }
    const targetKey = `${target.owner}/${target.repo}`
    return this.run('publish_github_task_assets', async (client) => {
      const uploadTarget = await resolveUploadTarget(client, target.owner, target.repo)
      const urlByAssetId = new Map<string, string>()
      for (const assetId of new Set(references.map((reference) => reference.assetId))) {
        const published = await publishedAssetUrl(assetId, this.id, targetKey)
        if (published) {
          urlByAssetId.set(assetId, published)
          continue
        }
        const url = await uploadGithubAsset(client, uploadTarget, assetId)
        // Record before the body is sent. An upload cannot be undone, so a failure
        // after this point must not cost a second one when the caller retries.
        await recordAssetPublication(assetId, this.id, targetKey, url)
        urlByAssetId.set(assetId, url)
      }
      return withPublishedAssets(body, urlByAssetId, githubAssetMarkdown)
    })
  }

  async remove(home: TaskHome): Promise<void> {
    const target = githubHome(home)
    if (target.kind === 'issue') throw new Error('An issue cannot be deleted from Solus. Close it instead.')
    await this.run('delete_github_draft', ({ graphql }) =>
      graphql(DELETE_ITEM_MUTATION, { projectId: target.projectId, itemId: target.itemId }))
  }
}
