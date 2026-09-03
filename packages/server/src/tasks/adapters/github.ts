import { canonicalRepoRef } from '../../providers/github/canonical-repo'
import type { GitHubClient } from '../../providers/github/octokit'
import { githubClients, runGithubRequest } from '../../providers/github/request'
import { z } from 'zod'
import type {
  CandidateTicket,
  ExternalTicketRef,
  NormalizedTaskComment,
  NormalizedTicket,
  Task,
  TaskAssigneeCandidate,
  TaskCandidateOptions,
  TaskCommentData,
  TaskStatus,
  TaskSyncField,
  TaskList,
  TicketPatch,
} from '@solus/contracts/task-types'
import { GitHubTaskProvider } from '../providers/github'
import {
  GITHUB_UPLOADABLE_ASSETS,
  resolveUploadTarget,
  uploadGithubAsset,
} from '../../providers/github/asset-upload'
import { publishedAssetUrl, recordAssetPublication } from '../asset-publications'
import { assetReferencesIn, withPublishedAssets, type AssetReference } from '../task-assets'
import { withTx } from '../../db'
import type { TaskSyncAdapter } from './types'

interface GitHubRepositoryRef {
  host: string
  owner: string
  repo: string
}

const taskRawSchema = z.object({
  comments: z.array(z.object({
    id: z.string().optional(),
    author: z.object({ login: z.string() }).nullable(),
    body: z.string(),
    createdAt: z.string(),
  })).optional(),
})
const githubSearchLabelSchema = z.object({ name: z.string().nullable().optional() })

function githubSearchLabelName(value: string | { name?: string | null }): string | undefined {
  const text = z.string().safeParse(value)
  if (text.success) return text.data
  return githubSearchLabelSchema.parse(value).name ?? undefined
}

function repositoryRef(externalKey: string): GitHubRepositoryRef {
  const [owner, repo, ...extra] = externalKey.split('/')
  if (!owner || !repo || extra.length) {
    throw new Error(`Invalid GitHub task scope: ${externalKey}`)
  }
  return { host: 'github.com', owner, repo }
}

async function withGithubTaskClient<Result>(
  operation: string,
  repo: GitHubRepositoryRef,
  run: (client: GitHubClient) => Promise<Result>,
): Promise<Result> {
  return runGithubRequest(operation, repo.host, await githubClients(repo.host), run)
}

/** An issue is open or closed, and "in progress" only in the sense that the
 *  task provider infers it. Three states is all GitHub can say. */
function statusKey(status: TaskStatus): 'open' | 'in_progress' | 'closed' {
  if (status === 'done' || status === 'dropped') return 'closed'
  if (status === 'in_progress' || status === 'in_review') return 'in_progress'
  return 'open'
}

/** What GitHub reports, spoken in the shared vocabulary. The three keys map
 *  back to their plainest local status; the engine restores local nuance by
 *  comparing `statusKey`. */
function normalizedStatus(task: Task): TaskStatus {
  const key = statusKey(task.status)
  if (key === 'closed') return 'done'
  if (key === 'in_progress') return 'in_progress'
  return 'todo'
}

function commentsFromTask(task: Task): NormalizedTaskComment[] {
  const parsed = taskRawSchema.safeParse(task.raw)
  const comments: TaskCommentData[] = parsed.success ? parsed.data.comments ?? [] : []
  return comments.flatMap((comment) => {
    if (!comment.id) return []
    return [{
      externalId: comment.id,
      author: comment.author?.login ?? null,
      body: comment.body,
      createdAt: Date.parse(comment.createdAt),
    }]
  })
}

function normalizeTask(task: Task, ref: ExternalTicketRef): NormalizedTicket {
  return {
    ...ref,
    url: task.url ?? ref.url,
    title: task.title,
    body: task.body,
    status: normalizedStatus(task),
    labels: task.labels,
    assignee: task.assignee,
    assigneeAvatarUrl: task.assigneeAvatarUrl,
    externalUpdatedAt: new Date(task.updatedAt).toISOString(),
    comments: commentsFromTask(task),
    snapshot: task.raw ?? task,
    priorityHint: task.priority,
  }
}

function providerFor(externalKey: string): GitHubTaskProvider {
  return new GitHubTaskProvider(repositoryRef(externalKey))
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

export class GitHubTaskSyncAdapter implements TaskSyncAdapter {
  readonly id = 'github' as const
  /** Priority is absent: on GitHub it is inferred from conventional labels, not
   *  a field an issue write can set. */
  readonly writableFields: ReadonlySet<TaskSyncField> = new Set(['title', 'body', 'status', 'labels', 'assignee'])
  readonly statuses = ['todo', 'in_progress', 'done'] as const

  statusKey(status: TaskStatus): string {
    return statusKey(status)
  }

  ticketUrl(
    target: Omit<ExternalTicketRef, 'externalId' | 'url'>,
    externalId: string,
  ): Promise<string> {
    return Promise.resolve(`https://github.com/${target.externalKey}/issues/${externalId}`)
  }

  async fetchTicket(ref: ExternalTicketRef): Promise<NormalizedTicket> {
    const task = await providerFor(ref.externalKey).getTask(ref.externalId)
    return normalizeTask(task, { ...ref, url: task.url ?? ref.url })
  }

  async fetchTickets(refs: ExternalTicketRef[]): Promise<NormalizedTicket[]> {
    // Keep failures scoped to the engine's per-link error state. Promise.all is
    // intentional here: providers can replace this adapter with a true batch
    // request without changing sync ownership or persistence.
    return Promise.all(refs.map((ref) => this.fetchTicket(ref)))
  }

  async pushFields(ref: ExternalTicketRef, patch: TicketPatch): Promise<NormalizedTicket> {
    const provider = providerFor(ref.externalKey)
    const update: Parameters<GitHubTaskProvider['updateTask']>[1] = {}
    if (patch.title !== undefined) update.title = patch.title
    if (patch.body !== undefined) update.body = patch.body
    if (patch.labels !== undefined) update.labels = patch.labels
    if (patch.status !== undefined) update.status = patch.status
    if (patch.assignee !== undefined) update.assignee = patch.assignee
    const task = await provider.updateTask(ref.externalId, update)
    return normalizeTask(task, { ...ref, url: task.url ?? ref.url })
  }

  async postComment(ref: ExternalTicketRef, body: string): Promise<NormalizedTaskComment> {
    const comment = await providerFor(ref.externalKey).postComment(ref.externalId, body)
    if (!comment.id) throw new Error('GitHub created a comment without an id.')
    return {
      externalId: comment.id,
      author: comment.author?.login ?? null,
      body: comment.body,
      createdAt: Date.parse(comment.createdAt),
    }
  }

  listAssigneeCandidates(
    target: Omit<ExternalTicketRef, 'externalId' | 'url'>,
  ): Promise<TaskAssigneeCandidate[]> {
    return providerFor(target.externalKey).listAssigneeCandidates()
  }

  unpublishableAssets(body: string): AssetReference[] {
    return assetReferencesIn(body).filter((reference) => !GITHUB_UPLOADABLE_ASSETS.has(reference.extension))
  }

  /**
   * The external key is the owner/repo the ticket lives in, which is also the
   * repository the assets are attached to and the target a publication is
   * recorded against: one screenshot on one repository uploads once, however
   * many comments reference it.
   */
  async publishAssets(ref: ExternalTicketRef, body: string): Promise<string> {
    const references = assetReferencesIn(body)
    if (!references.length) return body

    const repo = repositoryRef(ref.externalKey)
    return withGithubTaskClient('publish_github_task_assets', repo, async (client) => {
      const target = await resolveUploadTarget(client, repo.owner, repo.repo)
      const urlByAssetId = new Map<string, string>()
      for (const assetId of new Set(references.map((reference) => reference.assetId))) {
        const published = publishedAssetUrl(assetId, this.id, ref.externalKey)
        if (published) {
          urlByAssetId.set(assetId, published)
          continue
        }
        const url = await uploadGithubAsset(client, target, assetId)
        // Record before the body is sent. An upload cannot be undone, so a failure
        // after this point must not cost a second one when the caller retries.
        withTx(() => recordAssetPublication(assetId, this.id, ref.externalKey, url))
        urlByAssetId.set(assetId, url)
      }
      return withPublishedAssets(body, urlByAssetId, githubAssetMarkdown)
    })
  }

  async createTicket(
    target: Omit<ExternalTicketRef, 'externalId' | 'url'>,
    patch: Required<Pick<TicketPatch, 'title'>> & TicketPatch,
  ): Promise<NormalizedTicket> {
    const repo = repositoryRef(target.externalKey)
    const response = await withGithubTaskClient('create_github_task', repo, ({ rest }) => rest.issues.create({
      owner: repo.owner,
      repo: repo.repo,
      title: patch.title,
      body: patch.body,
      labels: patch.labels,
      assignees: patch.assignee ? [patch.assignee] : undefined,
    }))
    const externalId = String(response.data.number)
    const ref: ExternalTicketRef = {
      provider: 'github',
      externalKey: target.externalKey,
      externalId,
      url: response.data.html_url,
    }
    // A new issue is open. Only a status that closes it needs a second write.
    if (patch.status && statusKey(patch.status) !== 'open') {
      return this.pushFields(ref, { status: patch.status })
    }
    return this.fetchTicket(ref)
  }

  async listCandidates(
    target: Omit<ExternalTicketRef, 'externalId' | 'url'>,
    options: TaskCandidateOptions = {},
  ): Promise<CandidateTicket[]> {
    const query = options.query?.trim().toLowerCase()
    const limit = Math.max(1, Math.min(options.limit ?? 100, 200))
    const result = await providerFor(target.externalKey).listTasks()
    return result.tasks
      .filter((task) => !query || task.title.toLowerCase().includes(query) || task.id.includes(query))
      .slice(0, limit)
      .map((task) => ({
        provider: 'github' as const,
        externalKey: target.externalKey,
        externalId: task.id,
        url: task.url ?? `https://github.com/${target.externalKey}/issues/${task.id}`,
        title: task.title,
        status: normalizedStatus(task),
        labels: task.labels,
        externalUpdatedAt: new Date(task.updatedAt).toISOString(),
        priorityHint: task.priority,
      }))
  }

  listTickets(
    target: Omit<ExternalTicketRef, 'externalId' | 'url'>,
    options: TaskCandidateOptions = {},
  ): Promise<TaskList> {
    const involvement = options.involvement && options.involvement !== 'all'
      ? options.involvement
      : undefined
    const query = options.query?.trim()
    // The plain list is capped at the most recent issues, so a search has to
    // reach the provider: filtering the capped slice would answer "not found"
    // for an issue that is simply older than the cap.
    if (involvement || query) return this.searchTickets(target, { involvement, query })
    return providerFor(target.externalKey).listTasks()
  }

  private async searchTickets(
    target: Omit<ExternalTicketRef, 'externalId' | 'url'>,
    options: {
      involvement?: NonNullable<TaskCandidateOptions['involvement']>
      query?: string
    },
  ): Promise<TaskList> {
    if (options.involvement === 'review_requested') {
      throw new Error('GitHub issues do not support review-requested involvement.')
    }
    const qualifier = options.involvement
      ? { assigned: 'assignee:@me', authored: 'author:@me', mentioned: 'mentions:@me', all: '' }[options.involvement]
      : ''
    // An involvement view is about open work. A text search is about finding one
    // issue, which is as often a closed one.
    const state = options.query ? '' : 'is:open'
    // Search is the one GitHub surface that does not follow a repository
    // rename, so the bound name has to be resolved before it is a qualifier.
    const repo = repositoryRef(target.externalKey)
    const response = await withGithubTaskClient('search_github_tasks', repo, async (client) => {
      const scope = await canonicalRepoRef(client, repo)
      return client.rest.search.issuesAndPullRequests({
        q: [`repo:${scope.owner}/${scope.repo}`, 'is:issue', state, qualifier, options.query]
          .filter(Boolean).join(' '),
        sort: 'updated',
        order: 'desc',
        per_page: 100,
        page: 1,
      })
    })
    const tasks: Task[] = response.data.items.map((issue) => ({
      id: String(issue.number),
      providerId: 'github',
      kind: 'task',
      title: issue.title,
      body: issue.body ?? '',
      status: issue.state === 'closed'
        ? 'done'
        : issue.labels.some((label) =>
          githubSearchLabelName(label)?.toLowerCase() === 'in-progress')
          ? 'in_progress'
          : 'todo',
      url: issue.html_url,
      assignee: issue.assignee?.login,
      assigneeAvatarUrl: issue.assignee?.avatar_url,
      labels: issue.labels.flatMap((label) => {
        const name = githubSearchLabelName(label)
        return name ? [name] : []
      }),
      updatedAt: Date.parse(issue.updated_at),
    }))
    return {
      tasks,
      truncated: response.data.total_count > tasks.length,
    }
  }
}
