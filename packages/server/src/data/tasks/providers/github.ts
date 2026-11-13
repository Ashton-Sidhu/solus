import type { TaskRef, TaskStatusCategory } from '@solus/contracts/task-sources'
import type { TaskAssigneeCandidate, TaskPriority, TaskUpdatePatch } from '@solus/contracts/task-types'
import type { GitHubClient } from '../../../providers/github/octokit'
import {
  GITHUB_UPLOADABLE_ASSETS,
  resolveUploadTarget,
  uploadGithubAsset,
} from '../../../providers/github/asset-upload'
import { publishedAssetUrl, recordAssetPublication } from '../asset-publications'
import { isInsufficientScopes } from './failures'
import { assetReferencesIn, withPublishedAssets, type AssetReference } from '../task-assets'
import {
  CLEAR_PROJECT_FIELD_MUTATION,
  commentFromNode,
  DELETE_ITEM_MUTATION,
  DRAFT_ITEM_QUERY,
  draftToTask,
  DUE_FIELD_RE,
  ISSUE_QUERIES,
  PLAIN_ISSUE_QUERIES,
  issueState,
  issueToTask,
  priorityFromLabels,
  priorityFromOption,
  PROJECT_FIELDS_QUERY,
  projectItemsOf,
  restIssueToTask,
  SET_PROJECT_FIELD_MUTATION,
  statusValueOf,
  type IssueQueries,
  UPDATE_DRAFT_MUTATION,
  USER_ID_QUERY,
  type DraftItemResponse,
  type DraftNode,
  type IssueByNumberResponse,
  type IssueNode,
  type IssueProjectItemNode,
  type ProjectFieldsResponse,
  type TaskNodeResponse,
  type UpdateDraftResponse,
  type UserIdResponse,
} from './github-model'
import {
  TaskProviderError,
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

/**
 * Run an issue read with the Projects v2 values, and again without them when
 * the connection lacks the `read:project` scope. A repository and an issue do
 * not need that scope; only their board values do. The issue then reads as off
 * every board, so it takes no priority or due date write.
 */
export async function withoutProjectScope<Result>(read: (queries: IssueQueries) => Promise<Result>): Promise<Result> {
  try {
    return await read(ISSUE_QUERIES)
  } catch (error) {
    if (!isInsufficientScopes(error)) throw error
    return read(PLAIN_ISSUE_QUERIES)
  }
}

function githubHome(home: TaskHome): IssueHome | DraftHome {
  if (home.provider !== 'github') throw new Error(`The GitHub task provider cannot write to a ${home.provider} task.`)
  return home
}

function issueReference(home: IssueHome): string {
  return `${home.owner}/${home.repo}#${home.number}`
}

/** Read one issue by its number. GitHub reads follow a repository rename. */
export async function readIssueNode(graphql: Graphql, home: IssueHome): Promise<IssueNode> {
  const res = await withoutProjectScope((queries) => graphql<IssueByNumberResponse>(queries.issueByNumber, {
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
): Promise<TaskAssigneeCandidate[]> {
  return run('list_github_task_assignees', async ({ rest }) => {
    const { data } = await rest.issues.listAssignees({ owner: repository.owner, repo: repository.repo, per_page: 100 })
    return data.map((user) => ({ login: user.login, avatarUrl: user.avatar_url }))
  })
}

/** Put the fields of a write that succeeded on the task that a read gave. */
function withWrittenFields(task: ProviderTask, patch: TaskUpdatePatch, onBoard: boolean): ProviderTask {
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
): Promise<ProviderTask> {
  return run('create_github_task', async ({ rest }) => {
    const base = { owner: repository.owner, repo: repository.repo }
    const created = await rest.issues.create({
      ...base,
      title: draft.title,
      body: draft.body,
      labels: draft.labels,
      assignees: draft.assignee ? [draft.assignee] : undefined,
    })
    const issue = closed
      ? (await rest.issues.update({ ...base, issue_number: created.data.number, state: 'closed' })).data
      : created.data
    return restIssueToTask(issue, base)
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

/** The field id and the option ids that a write to one Project needs. */
interface ResolvedProjectFields {
  due?: { id: string }
  priority?: { id: string; options: Array<{ id: string; name: string }> }
}

/**
 * GitHub issues and the draft items of GitHub Projects, read and written by
 * the task's `home`. GitHub stays the owner of the content: an issue cannot be
 * deleted from Solus.
 */
export class GitHubTaskProvider implements TaskProviderAdapter {
  readonly id = 'github' as const

  // The field definitions of a Project are stable, so one read for each
  // Project serves every board field write.
  private readonly projectFieldsCache = new Map<string, ResolvedProjectFields>()

  constructor(private readonly run: GithubRun) {}

  async fetch(ref: TaskRef): Promise<ProviderTaskDetails> {
    if (ref.provider !== 'github') throw new Error(`The GitHub task provider cannot read a ${ref.provider} task.`)
    return this.run('get_github_task', async ({ graphql }) => {
      const { node } = await withoutProjectScope((queries) => graphql<TaskNodeResponse>(queries.taskNode, { id: ref.id }))
      if (node?.__typename === 'Issue') {
        const comments = node.comments ?? { totalCount: 0, nodes: [] }
        return {
          task: issueToTask(node),
          comments: comments.nodes.map(commentFromNode),
          commentsTruncated: comments.totalCount > comments.nodes.length,
        }
      }
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
  async update(home: TaskHome, patch: TaskUpdatePatch): Promise<ProviderTask> {
    const target = githubHome(home)
    return target.kind === 'issue' ? this.updateIssue(target, patch) : this.updateDraft(target, patch)
  }

  private updateIssue(home: IssueHome, patch: TaskUpdatePatch): Promise<ProviderTask> {
    return this.run('update_github_task', async ({ rest, graphql }) => {
      // Only a board field write needs the board items before the write.
      if (patch.dueDate !== undefined || patch.priority !== undefined) {
        const items = projectItemsOf(await readIssueNode(graphql, home))
        if (patch.dueDate !== undefined) await this.writeDueDate(graphql, home, items, patch.dueDate)
        if (patch.priority !== undefined) await this.writePriority(graphql, home, items, patch.priority)
      }

      // `labels` replaces the whole set, and one assignee replaces all assignees.
      const assignees = patch.assignee === undefined ? undefined : patch.assignee ? [patch.assignee] : []
      if (
        patch.title !== undefined || patch.body !== undefined
        || patch.labels !== undefined || assignees !== undefined
      ) {
        await rest.issues.update({
          owner: home.owner,
          repo: home.repo,
          issue_number: home.number,
          title: patch.title,
          body: patch.body,
          labels: patch.labels,
          assignees,
        })
      }

      // GitHub's GraphQL reads lag its REST writes, so a read immediately after
      // the write can give the issue as it was. The writes above succeeded, so
      // the written fields replace the possibly stale read.
      const node = await readIssueNode(graphql, home)
      return withWrittenFields(issueToTask(node), patch, projectItemsOf(node).length > 0)
    })
  }

  private async updateDraft(home: DraftHome, patch: TaskUpdatePatch): Promise<ProviderTask> {
    if (patch.labels !== undefined || patch.priority !== undefined || patch.dueDate !== undefined) {
      throw new Error('A draft item of a GitHub Project takes a title, a body and an assignee only.')
    }
    return this.run('update_github_draft', async ({ graphql }) => {
      // The mutation takes the draft's id, which is the content of the board item.
      const before = await readDraftItem(graphql, home.itemId)
      const assigneeIds = patch.assignee === undefined
        ? undefined
        : patch.assignee ? [await githubUserId(graphql, patch.assignee)] : []
      const res = await graphql<UpdateDraftResponse>(UPDATE_DRAFT_MUTATION, {
        draftIssueId: before.ref.id,
        title: patch.title,
        body: patch.body,
        assigneeIds,
      })
      const draft: DraftNode = res.updateProjectV2DraftIssue.draftIssue
      return { ...draftToTask(draft, { projectId: home.projectId, itemId: home.itemId, statusName: null }), state: before.state }
    })
  }

  /** Set or clear the due date on the first board item whose Project has a date field. */
  private async writeDueDate(
    graphql: Graphql,
    home: IssueHome,
    items: IssueProjectItemNode[],
    dueDate: string | null,
  ): Promise<void> {
    for (const item of items) {
      const fields = await this.resolveProjectFields(graphql, item.project.id)
      if (!fields.due) continue
      if (dueDate) {
        await graphql(SET_PROJECT_FIELD_MUTATION, {
          projectId: item.project.id,
          itemId: item.id,
          fieldId: fields.due.id,
          value: { date: dueDate },
        })
      } else {
        await this.clearField(graphql, item, fields.due.id)
      }
      return
    }
    throw new Error(`${issueReference(home)} is on no GitHub Project with a date field, so it takes no due date.`)
  }

  /** Set or clear the Priority option on the first board item whose Project has the field. */
  private async writePriority(
    graphql: Graphql,
    home: IssueHome,
    items: IssueProjectItemNode[],
    priority: TaskPriority | null,
  ): Promise<void> {
    for (const item of items) {
      const fields = await this.resolveProjectFields(graphql, item.project.id)
      if (!fields.priority) continue
      if (!priority) {
        await this.clearField(graphql, item, fields.priority.id)
        return
      }
      const option = fields.priority.options.find((candidate) => priorityFromOption(candidate.name) === priority)
      if (!option) {
        throw new Error(`The Priority field of this GitHub Project has no option for ${priority}.`)
      }
      await graphql(SET_PROJECT_FIELD_MUTATION, {
        projectId: item.project.id,
        itemId: item.id,
        fieldId: fields.priority.id,
        value: { singleSelectOptionId: option.id },
      })
      return
    }
    throw new Error(`${issueReference(home)} is on no GitHub Project with a Priority field, so it takes no priority.`)
  }

  /** Read the field definitions of a Project once, and find its fields by convention. */
  private async resolveProjectFields(graphql: Graphql, projectId: string): Promise<ResolvedProjectFields> {
    const cached = this.projectFieldsCache.get(projectId)
    if (cached) return cached
    const res = await graphql<ProjectFieldsResponse>(PROJECT_FIELDS_QUERY, { projectId })
    const fields: ResolvedProjectFields = {}
    let firstDate: { id: string } | undefined
    let namedDate: { id: string } | undefined
    for (const field of res.node?.fields?.nodes ?? []) {
      if (!field?.id || !field.name) continue
      if (field.dataType === 'SINGLE_SELECT') {
        if (field.name.toLowerCase() === 'priority') fields.priority = { id: field.id, options: field.options ?? [] }
      } else if (field.dataType === 'DATE') {
        if (!firstDate) firstDate = { id: field.id }
        if (!namedDate && DUE_FIELD_RE.test(field.name)) namedDate = { id: field.id }
      }
    }
    fields.due = namedDate ?? firstDate
    this.projectFieldsCache.set(projectId, fields)
    return fields
  }

  private async clearField(graphql: Graphql, item: IssueProjectItemNode, fieldId: string): Promise<void> {
    await graphql(CLEAR_PROJECT_FIELD_MUTATION, { projectId: item.project.id, itemId: item.id, fieldId })
  }

  async setState(home: TaskHome, category: TaskStatusCategory): Promise<ProviderTask> {
    const target = githubHome(home)
    if (target.kind === 'draft') {
      throw new Error('A draft item has no state of its own. Move it on its GitHub Project.')
    }
    return this.run('set_github_task_state', async ({ rest, graphql }) => {
      const closed = category === 'done'
      await rest.issues.update({
        owner: target.owner,
        repo: target.repo,
        issue_number: target.number,
        state: closed ? 'closed' : 'open',
      })
      // The GraphQL read can lag the REST write, so the written state replaces it.
      const task = issueToTask(await readIssueNode(graphql, target))
      task.state = issueState(closed ? 'CLOSED' : 'OPEN')
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

  async assignees(home: TaskHome): Promise<TaskAssigneeCandidate[]> {
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
