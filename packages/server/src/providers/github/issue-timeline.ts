import { z } from 'zod'
import type { TaskProviderEvent, TaskProviderPullRequest } from '@solus/contracts/task-data'
import type { TaskComment } from '@solus/contracts/task-types'
import type { GitHubClient } from './octokit'

const login = z.object({ login: z.string().optional() }).nullish().catch(undefined)
const timelineEntry = z.object({
  event: z.string().min(1),
  id: z.number().nullish(),
  node_id: z.string().nullish(),
  created_at: z.string().nullish(),
  actor: login,
  user: login,
  assignee: login,
  body: z.string().nullish(),
  label: z.object({ name: z.string() }).nullish().catch(undefined),
  milestone: z.object({ title: z.string() }).nullish().catch(undefined),
  rename: z.object({ from: z.string(), to: z.string() }).nullish().catch(undefined),
  commit_id: z.string().nullish(),
  commit_url: z.string().nullish(),
  source: z.object({
    issue: z.object({
      html_url: z.string(),
      number: z.number(),
      title: z.string(),
      state: z.string(),
      pull_request: z.object({ merged_at: z.string().nullish() }).nullish()
    }).nullish()
  }).nullish().catch(undefined)
})

function pageLink(links: string, relation: 'last' | 'next'): number | undefined {
  for (const link of links.split(',')) {
    const match = /^\s*<([^>]+)>;\s*rel="([^"]+)"/.exec(link)
    if (match?.[2] !== relation || !URL.canParse(match[1])) continue
    const page = Number(new URL(match[1]).searchParams.get('page'))
    if (Number.isSafeInteger(page) && page > 0) return page
  }
}

function commitLink(url: string | null | undefined, sha: string) {
  const match = url?.match(/^https:\/\/api\.github\.com\/repos\/([\w.-]+)\/([\w.-]+)\/commits\/([a-f0-9]{40}|[a-f0-9]{64})$/i)
  if (!match || match[3] !== sha) return undefined
  return { url: `https://github.com/${match[1]}/${match[2]}/commit/${sha}`, label: sha.slice(0, 7) }
}

type IssueCoordinates = { owner: string; repo: string; number: number }
type TimelineEntry = z.infer<typeof timelineEntry>

function eventText(item: TimelineEntry): string {
  switch (item.event) {
    case 'assigned': return item.assignee?.login && item.assignee.login === item.actor?.login
      ? 'self-assigned this issue' : `assigned ${item.assignee?.login ?? 'an account'}`
    case 'unassigned': return `unassigned ${item.assignee?.login ?? 'an account'}`
    case 'labeled': return `added label ${item.label?.name ?? ''}`.trim()
    case 'unlabeled': return `removed label ${item.label?.name ?? ''}`.trim()
    case 'renamed': return item.rename ? `changed the title from “${item.rename.from}” to “${item.rename.to}”` : 'renamed the issue'
    case 'milestoned': return `added this issue to milestone ${item.milestone?.title ?? ''}`.trim()
    case 'demilestoned': return `removed this issue from milestone ${item.milestone?.title ?? ''}`.trim()
    case 'referenced': return 'added a commit that references this issue'
    case 'cross-referenced': return 'referenced this issue'
    case 'closed': return 'closed the issue'
    case 'reopened': return 'reopened the issue'
    case 'locked': return 'locked the conversation'
    case 'unlocked': return 'unlocked the conversation'
    case 'pinned': return 'pinned the issue'
    case 'unpinned': return 'unpinned the issue'
    case 'transferred': return 'transferred the issue'
    default: return `recorded “${item.event.replaceAll('_', ' ')}”`
  }
}

/** GitHub returns every timeline event it exposes. Use its page links, and
 * keep new event types visible even before Solus has a description for them. */
export async function readGithubIssueTimeline(
  rest: GitHubClient['rest'],
  taskId: string,
  issue: IssueCoordinates,
  cursor?: string
): Promise<{
  events: TaskProviderEvent[]
  comments: TaskComment[]
  pullRequests: TaskProviderPullRequest[]
  historyCursor: string | null
}> {
  const position = cursor && /^(older|newer):([1-9]\d{0,8})$/.exec(cursor)
  if (cursor && !position) throw new Error('Refresh activity to load the current GitHub timeline.')
  const read = (page: number) => rest.issues.listEventsForTimeline({
    owner: issue.owner, repo: issue.repo, issue_number: issue.number, page, per_page: 50
  })
  let page = position ? Number(position[2]) : 1
  let response = await read(page)
  const last = position ? undefined : pageLink(response.headers.link ?? '', 'last')
  if (last && last > page) {
    page = last
    response = await read(page)
  }
  const next = pageLink(response.headers.link ?? '', 'next')
  const readingOlder = position ? position[1] === 'older' : !!last
  const historyCursor = readingOlder
    ? page > 1 ? `older:${page - 1}` : null
    : next ? `newer:${next}` : null
  const events: TaskProviderEvent[] = []
  const comments: TaskComment[] = []
  const pullRequests = new Map<string, TaskProviderPullRequest>()
  for (const [index, value] of response.data.entries()) {
    const parsed = timelineEntry.safeParse(value)
    if (!parsed.success) continue
    const item = parsed.data
    const at = Date.parse(item.created_at ?? '')
    if (!Number.isFinite(at)) continue
    const id = item.node_id ?? String(item.id ?? `${item.event}:${page}:${index}`)
    const actor = item.actor?.login ?? item.user?.login ?? null
    if (item.event === 'commented' && item.body != null) {
      comments.push({ id, providerCommentId: id, taskId, body: item.body, externalAuthor: actor, createdAt: at })
      continue
    }
    const source = item.source?.issue
    const link = source?.html_url.startsWith('https://github.com/')
      ? { url: source.html_url, label: source.title }
      : item.commit_id ? commitLink(item.commit_url, item.commit_id) : undefined
    events.push({ id, at, actor, text: eventText(item), ...(link && { link }) })
    if (source?.pull_request && link) {
      pullRequests.set(link.url, {
        url: link.url, number: source.number, title: link.label,
        state: source.pull_request.merged_at ? 'merged' : source.state === 'open' ? 'open'
          : source.pull_request.merged_at === null ? 'closed' : 'unknown',
        closesIssue: false
      })
    }
  }
  return { events, comments, pullRequests: [...pullRequests.values()], historyCursor }
}
