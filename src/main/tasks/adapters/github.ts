import { GitHubAuth } from '../../providers/github/auth'
import { buildClient } from '../../providers/github/octokit'
import type {
  CandidateTicket,
  ExternalTaskStatus,
  ExternalTicketRef,
  NormalizedTaskComment,
  NormalizedTicket,
  Task,
  TaskCandidateOptions,
  TaskCommentData,
  TaskPriority,
  TicketPatch,
} from '../../../shared/task-types'
import { GitHubTaskProvider } from '../providers/github'
import type { TaskSyncAdapter } from './types'

function repositoryRef(externalKey: string): { host: string; owner: string; repo: string } {
  const [owner, repo, ...extra] = externalKey.split('/')
  if (!owner || !repo || extra.length) {
    throw new Error(`Invalid GitHub task scope: ${externalKey}`)
  }
  return { host: 'github.com', owner, repo }
}

function issueNumber(externalId: string): number {
  const number = Number(externalId)
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`Invalid GitHub issue number: ${externalId}`)
  }
  return number
}

function externalStatus(task: Task): ExternalTaskStatus {
  if (task.status === 'done' || task.status === 'dropped') return 'closed'
  if (task.status === 'in_progress' || task.status === 'in_review') return 'in_progress'
  return 'open'
}

function commentsFromTask(task: Task): NormalizedTaskComment[] {
  const raw = task.raw as { comments?: TaskCommentData[] } | null | undefined
  return (raw?.comments ?? []).flatMap((comment) => {
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
    status: externalStatus(task),
    labels: task.labels,
    externalUpdatedAt: new Date(task.updatedAt).toISOString(),
    comments: commentsFromTask(task),
    snapshot: task.raw ?? task,
    priorityHint: task.priority,
  }
}

function localStatus(status: ExternalTaskStatus): Task['status'] {
  if (status === 'closed') return 'done'
  if (status === 'in_progress') return 'in_progress'
  return 'todo'
}

function providerFor(externalKey: string): GitHubTaskProvider {
  return new GitHubTaskProvider(repositoryRef(externalKey))
}

export class GitHubTaskSyncAdapter implements TaskSyncAdapter {
  readonly id = 'github' as const

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
    const task = await provider.updateTask(ref.externalId, {
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.body === undefined ? {} : { body: patch.body }),
      ...(patch.labels === undefined ? {} : { labels: patch.labels }),
      ...(patch.status === undefined ? {} : { status: localStatus(patch.status) }),
    })
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

  async createTicket(
    target: Omit<ExternalTicketRef, 'externalId' | 'url'>,
    patch: Required<Pick<TicketPatch, 'title'>> & TicketPatch,
  ): Promise<NormalizedTicket> {
    const repo = repositoryRef(target.externalKey)
    const { rest } = await buildClient(new GitHubAuth())
    const response = await rest.issues.create({
      owner: repo.owner,
      repo: repo.repo,
      title: patch.title,
      body: patch.body,
      labels: patch.labels,
    })
    const externalId = String(response.data.number)
    const ref: ExternalTicketRef = {
      provider: 'github',
      externalKey: target.externalKey,
      externalId,
      url: response.data.html_url,
    }
    if (patch.status && patch.status !== 'open') {
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
        status: externalStatus(task),
        labels: task.labels,
        externalUpdatedAt: new Date(task.updatedAt).toISOString(),
        priorityHint: task.priority as TaskPriority | undefined,
      }))
  }
}

