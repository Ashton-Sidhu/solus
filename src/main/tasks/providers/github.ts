import { GitHubAuth } from '../../providers/github/auth'
import { buildClient, type GitHubClient } from '../../providers/github/octokit'
import { resolveRepoRef } from '../../git/git-helpers'
import { createLogger } from '../../logger'
import type { RepoRef } from '../../providers/types'
import type { Task, TaskCommentData, TaskKind, TaskList, TaskPriority, TaskProvider, TaskStatus } from '../../../shared/task-types'

const log = createLogger('main', 'github-tasks')

// GitHub Issues are open/closed + labels only — there's no native "In Progress".
// We map it to a conventional label so write-back works on every repo (Projects
// v2 status fields are a later enhancement). See the Task System Design work.
const IN_PROGRESS_LABEL = 'in-progress'

// Bound the list so a huge backlog can't make the panel hang or balloon memory;
// the cache layer refreshes the most-recently-updated slice. Pagination beyond
// this is a fast-follow.
const MAX_ISSUES = 200
const PAGE_SIZE = 50

// ─── GraphQL documents ────────────────────────────────────────────────────────
// GraphQL (not REST) because we need the sub-issue graph (parent/children, GA
// 2025), issue types, and linked PRs in one round-trip — REST exposes none of
// these on the issues endpoints.

// `projectItems` carries the Projects v2 metadata (status / due / priority) that
// rides along with each issue — the item id + project id we need to write back,
// plus the current field values. `field { ... on ProjectV2FieldCommon { name } }`
// is required because a value's `field` is a union; only the common interface
// exposes `name`, which is how we auto-detect Status/Due/Priority by convention.
const ISSUE_FIELDS = `
  number
  title
  body
  state
  url
  updatedAt
  issueType { name }
  labels(first: 20) { nodes { name } }
  assignees(first: 5) { nodes { login } }
  parent { number }
  subIssuesSummary { total }
  linkedPr: closedByPullRequestsReferences(first: 1, includeClosedPrs: false) {
    nodes { number url headRefName }
  }
  projectItems(first: 10) {
    nodes {
      id
      project { id }
      fieldValues(first: 20) {
        nodes {
          __typename
          ... on ProjectV2ItemFieldDateValue {
            date
            field { ... on ProjectV2FieldCommon { name } }
          }
          ... on ProjectV2ItemFieldSingleSelectValue {
            name
            field { ... on ProjectV2FieldCommon { name } }
          }
        }
      }
    }
  }
`

// `filterBy` is passed as a whole nullable variable, NOT `{ assignee: $assignee }`:
// GitHub treats `filterBy: { assignee: null }` as "issues with NO assignee", so a
// hard-coded assignee key silently hides every assigned issue. Passing the entire
// IssueFilters object (null when we're not scoping to the viewer) means no filter.
const LIST_ISSUES_QUERY = `
  query($owner: String!, $repo: String!, $states: [IssueState!], $filters: IssueFilters, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      issues(
        first: ${PAGE_SIZE}
        after: $cursor
        states: $states
        filterBy: $filters
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes { ${ISSUE_FIELDS} }
      }
    }
  }
`

const GET_ISSUE_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        ${ISSUE_FIELDS}
        subIssues(first: 100) { nodes { number } }
        comments(first: 100) {
          nodes { id author { login } body createdAt }
        }
        closedByPullRequestsReferences(first: 20, includeClosedPrs: true) {
          nodes { number title url state }
        }
      }
    }
  }
`

const VIEWER_QUERY = `query { viewer { login } }`

// Resolve a project's field definitions (ids + single-select option ids) so we
// can write back. Keyed on the project's node id and memoized — field defs are
// stable. `ProjectV2FieldCommon` covers id/name/dataType for every field type;
// the single-select fragment adds its options.
const PROJECT_FIELDS_QUERY = `
  query($projectId: ID!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        fields(first: 50) {
          nodes {
            __typename
            ... on ProjectV2FieldCommon { id name dataType }
            ... on ProjectV2SingleSelectField { options { id name } }
          }
        }
      }
    }
  }
`

// The issue's project items, fetched at write time to locate the item id +
// project id to mutate (the list/get reads carry field *values*, but a write
// needs the item id paired with its project's field *definitions*).
const ISSUE_PROJECT_ITEMS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        projectItems(first: 10) { nodes { id project { id } } }
      }
    }
  }
`

const SET_PROJECT_FIELD_MUTATION = `
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
    updateProjectV2ItemFieldValue(
      input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }
    ) { projectV2Item { id } }
  }
`

const CLEAR_PROJECT_FIELD_MUTATION = `
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
    clearProjectV2ItemFieldValue(
      input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId }
    ) { projectV2Item { id } }
  }
`

// Link an existing issue under a parent as a native sub-issue (GA 2025). Takes
// both issues' GraphQL node ids, not their numbers.
const ADD_SUB_ISSUE_MUTATION = `
  mutation($issueId: ID!, $subIssueId: ID!) {
    addSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) {
      issue { number }
    }
  }
`

// ─── GraphQL node shapes ──────────────────────────────────────────────────────

interface IssueNode {
  number: number
  title: string
  body: string | null
  state: 'OPEN' | 'CLOSED'
  url: string
  updatedAt: string
  issueType: { name: string } | null
  labels: { nodes: { name: string }[] }
  assignees: { nodes: { login: string }[] }
  parent: { number: number } | null
  subIssuesSummary: { total: number } | null
  // The active PR that will close this issue (open only, first one) — present on
  // both the list and the hydrated response, so cards can show the PR/branch too.
  linkedPr?: { nodes: { number: number; url: string; headRefName: string }[] }
  // Projects v2 metadata (status/due/priority) riding along with the issue.
  projectItems?: { nodes: ProjectItemNode[] }
  // Present only on the hydrated getTask response:
  subIssues?: { nodes: { number: number }[] }
  comments?: { nodes: GitHubComment[] }
  closedByPullRequestsReferences?: { nodes: GitHubLinkedPr[] }
}

// A single Projects v2 field value on an item. Date values carry `date`,
// single-selects carry `name`; both carry the owning `field`'s name (used to
// detect Status/Due/Priority by convention).
interface ProjectFieldValueNode {
  __typename: string
  date?: string | null
  name?: string | null
  field?: { name?: string | null } | null
}

interface ProjectItemNode {
  id: string
  project: { id: string }
  fieldValues: { nodes: ProjectFieldValueNode[] }
}

interface GitHubComment {
  id: string
  author: { login: string } | null
  body: string
  createdAt: string
}

interface GitHubLinkedPr {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
}

/**
 * The provider payload we stash in `Task.raw` so the session-binding layer can
 * inject full context (comments + linked PRs) at session start without a second
 * round-trip. Typed so consumers don't reach into `unknown`.
 */
export interface GitHubTaskRaw {
  number: number
  comments: GitHubComment[]
  linkedPrs: GitHubLinkedPr[]
}

// ─── Mappers (GraphQL → host-neutral Task) ────────────────────────────────────

function normalizeStatus(node: IssueNode, labels: string[]): TaskStatus {
  // The in-progress label wins over closed/open: a closed issue is still "done",
  // but an explicitly in-progress open issue should read as such.
  if (node.state === 'CLOSED') return 'done'
  if (labels.includes(IN_PROGRESS_LABEL)) return 'in_progress'
  return 'open'
}

// Conventional priority labels → normalized priority. Covers the common schemes
// (`priority: high`, `p1`, bare `urgent`). First match by descending severity wins.
const PRIORITY_LABELS: { priority: TaskPriority; match: RegExp }[] = [
  { priority: 'urgent', match: /^(priority\s*[:/-]?\s*)?(urgent|critical|p0)$/i },
  { priority: 'high', match: /^(priority\s*[:/-]?\s*)?(high|p1)$/i },
  { priority: 'medium', match: /^(priority\s*[:/-]?\s*)?(medium|med|p2)$/i },
  { priority: 'low', match: /^(priority\s*[:/-]?\s*)?(low|p3)$/i },
]

function priorityFromLabels(labels: string[]): TaskPriority | undefined {
  for (const { priority, match } of PRIORITY_LABELS) {
    if (labels.some((l) => match.test(l.trim()))) return priority
  }
  return undefined
}

// ─── Projects v2 field discovery (by convention) ──────────────────────────────
// Project fields are user-defined, so we detect them by type + name off the
// issue's project item rather than any stored mapping (a deliberate fast-follow).

// A DATE field is "due" if its name reads like one; otherwise the first DATE
// field on the item is used as a fallback.
const DUE_FIELD_RE = /due|target|end|ship/i

// Reuse the label priority schemes against single-select option names
// (`Urgent`/`P0`/`High`…), so a board's Priority options map the same way labels do.
function priorityFromOption(name: string): TaskPriority | undefined {
  for (const { priority, match } of PRIORITY_LABELS) {
    if (match.test(name.trim())) return priority
  }
  return undefined
}

// Map a Status single-select option name onto our normalized status. Unknown
// option names yield undefined so the caller can fall back to open/closed.
function statusFromOption(name: string): TaskStatus | undefined {
  const n = name.toLowerCase()
  if (/done|complete|closed|shipped|merged/.test(n)) return 'done'
  if (/progress|doing|review|started|active/.test(n)) return 'in_progress'
  if (/todo|to do|backlog|open|ready|triage|new|planned/.test(n)) return 'open'
  return undefined
}

/**
 * Read status / due / priority off an issue's project items. Multi-board: the
 * first item carrying each field wins (resolved independently per field). Due
 * date prefers a conventionally-named DATE field, falling back to the first one.
 */
function readProjectFields(items: ProjectItemNode[]): {
  status?: TaskStatus
  dueDate?: string
  priority?: TaskPriority
} {
  let status: TaskStatus | undefined
  let priority: TaskPriority | undefined
  let namedDue: string | undefined
  let anyDue: string | undefined
  for (const item of items) {
    for (const v of item.fieldValues.nodes) {
      const fname = v.field?.name?.toLowerCase()
      if (v.__typename === 'ProjectV2ItemFieldSingleSelectValue' && v.name) {
        if (fname === 'status' && status === undefined) status = statusFromOption(v.name)
        else if (fname === 'priority' && priority === undefined) priority = priorityFromOption(v.name)
      } else if (v.__typename === 'ProjectV2ItemFieldDateValue' && v.date) {
        if (anyDue === undefined) anyDue = v.date
        if (namedDue === undefined && DUE_FIELD_RE.test(v.field?.name ?? '')) namedDue = v.date
      }
    }
  }
  return { status, dueDate: namedDue ?? anyDue, priority }
}

// ─── Projects v2 write-back ────────────────────────────────────────────────────
// Resolved (id-bearing) field definitions for one project, so writes can target
// the right field + option. Memoized per project id (defs are stable).

interface ResolvedSelectField {
  id: string
  options: { id: string; name: string }[]
}

interface ProjectFields {
  status?: ResolvedSelectField
  due?: { id: string }
  priority?: ResolvedSelectField
}

interface ProjectFieldDefNode {
  __typename: string
  id?: string
  name?: string
  dataType?: string
  options?: { id: string; name: string }[]
}

interface ProjectFieldsResponse {
  node: { fields: { nodes: ProjectFieldDefNode[] } } | null
}

interface IssueProjectItemsResponse {
  repository: { issue: { projectItems: { nodes: ProjectItemRef[] } } | null }
}

interface ProjectItemRef {
  id: string
  project: { id: string }
}

interface IssueMutationBase {
  owner: string
  repo: string
  issue_number: number
}

function issueKind(node: IssueNode): TaskKind {
  // Either an explicit "Epic" issue type or the presence of sub-issues makes
  // this a grouping parent. Sub-issues is the more faithful signal.
  if (node.issueType?.name?.toLowerCase() === 'epic') return 'epic'
  if ((node.subIssuesSummary?.total ?? 0) > 0) return 'epic'
  return 'task'
}

function issueToTask(node: IssueNode): Task {
  const labels = node.labels.nodes.map((l) => l.name)
  const raw: GitHubTaskRaw = {
    number: node.number,
    comments: node.comments?.nodes ?? [],
    linkedPrs: node.closedByPullRequestsReferences?.nodes ?? [],
  }
  // Hydrate the branch + PR straight from the issue's active linked PR — the
  // outbound half of the loop, native to GitHub (no gh shell-out needed).
  const active = node.linkedPr?.nodes[0]
  // On a board, planning fields come *only* from the project item — we stop
  // inferring priority from labels and read status off the Status field (falling
  // back to open/closed when the board has no Status value). Off any board, the
  // legacy label/state behaviour is untouched.
  const projectItems = node.projectItems?.nodes ?? []
  const onBoard = projectItems.length > 0
  const planning = onBoard ? readProjectFields(projectItems) : {}
  const boardStatus = planning.status ?? (node.state === 'CLOSED' ? 'done' : 'open')
  return {
    id: String(node.number),
    providerId: 'github',
    kind: issueKind(node),
    title: node.title,
    body: node.body ?? '',
    status: onBoard ? boardStatus : normalizeStatus(node, labels),
    url: node.url,
    assignee: node.assignees.nodes[0]?.login,
    labels,
    priority: onBoard ? planning.priority : priorityFromLabels(labels),
    parentId: node.parent ? String(node.parent.number) : undefined,
    childIds: node.subIssues?.nodes.map((n) => String(n.number)),
    dueDate: onBoard ? planning.dueDate : undefined,
    branch: active?.headRefName,
    pr: active ? { url: active.url, number: active.number } : undefined,
    canEditPlanningFields: onBoard,
    updatedAt: node.updatedAt,
    raw,
  }
}

/** Parse our string id back to the issue number, rejecting anything else early. */
function toIssueNumber(id: string): number {
  const n = Number(id)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid GitHub task id: ${id}`)
  return n
}

// ─── Provider ─────────────────────────────────────────────────────────────────

/**
 * GitHub Issues behind the host-neutral `TaskProvider`. Bound to a single repo
 * (auto-detected from the project's `origin` remote). Supports reads, status
 * write-back, posting comments, and creating issues (including linking a new one
 * under a parent as a native sub-issue). Deleting remote issues is intentionally
 * omitted (that optional mutator stays undefined so callers feature-detect),
 * keeping GitHub authoritative for content.
 */
export class GitHubTaskProvider implements TaskProvider {
  readonly id = 'github' as const

  // Project field definitions are stable, so memoize them per project node id to
  // avoid a resolve query on every planning-field write.
  private readonly projectFieldsCache = new Map<string, ProjectFields>()

  constructor(
    private readonly repo: RepoRef,
    private readonly auth: GitHubAuth = new GitHubAuth(),
  ) {}

  /** Lazily build an authenticated REST + GraphQL client. */
  private client(): Promise<GitHubClient> {
    return buildClient(this.auth)
  }

  async listTasks(opts: { assignedToMe?: boolean } = {}): Promise<TaskList> {
    const { graphql } = await this.client()
    // null filters = no scoping (all issues); only narrow to the viewer on demand.
    const filters = opts.assignedToMe ? { assignee: await this.viewerLogin(graphql) } : null

    const tasks: Task[] = []
    let truncated = false
    // Open issues first, then closed with whatever budget remains: everything is
    // capped at MAX_ISSUES, and a busy repo's recently-closed churn must not
    // crowd still-open work out of the capped slice.
    outer: for (const states of [['OPEN'], ['CLOSED']]) {
      let cursor: string | null = null
      for (;;) {
        const res: ListIssuesResponse = await graphql<ListIssuesResponse>(LIST_ISSUES_QUERY, {
          owner: this.repo.owner,
          repo: this.repo.repo,
          states,
          filters,
          cursor,
        })
        const page = res.repository.issues
        for (const node of page.nodes) {
          if (tasks.length >= MAX_ISSUES) {
            truncated = true
            break outer
          }
          tasks.push(issueToTask(node))
        }
        if (!page.pageInfo.hasNextPage) break
        if (tasks.length >= MAX_ISSUES) {
          truncated = true
          break outer
        }
        cursor = page.pageInfo.endCursor
      }
    }
    return truncated ? { tasks, truncated } : { tasks }
  }

  async getTask(id: string): Promise<Task> {
    const { graphql } = await this.client()
    const res = await graphql<GetIssueResponse>(GET_ISSUE_QUERY, {
      owner: this.repo.owner,
      repo: this.repo.repo,
      number: toIssueNumber(id),
    })
    const issue = res.repository.issue
    if (!issue) throw new Error(`GitHub issue #${id} not found in ${this.repo.owner}/${this.repo.repo}`)
    return issueToTask(issue)
  }

  /**
   * Create an issue upstream from `title` + `body` (+ optional labels), then
   * return it re-hydrated through getTask. When `parentId` is set we link the new
   * issue as a native sub-issue of that parent (GA 2025, GraphQL) so epics created
   * in Solus map faithfully; a linking failure leaves the issue created but flat
   * rather than failing the whole write. `kind` is ignored — GitHub has no native
   * epic type, the parent/child link is what makes an issue read as an epic.
   */
  async createTask(input: Partial<Task>): Promise<Task> {
    const title = input.title?.trim()
    if (!title) throw new Error('A title is required to create a GitHub issue.')
    const { rest, graphql } = await this.client()
    const created = await rest.issues.create({
      owner: this.repo.owner,
      repo: this.repo.repo,
      title,
      body: input.body?.trim() || undefined,
      labels: input.labels?.length ? input.labels : undefined,
    })
    if (input.parentId) {
      try {
        await this.linkSubIssue(rest, graphql, input.parentId, created.data.node_id)
      } catch (err) {
        // Keep the issue — it just won't be nested. Surfaced in logs, not to the
        // user, since the create itself succeeded.
        log.warn(`Created issue #${created.data.number} but failed to link under #${input.parentId}: ${String(err)}`)
      }
    }
    return this.getTask(String(created.data.number))
  }

  /** Link an existing issue as a sub-issue of `parentId` via the GraphQL
   *  addSubIssue mutation (needs both issues' GraphQL node ids). */
  private async linkSubIssue(
    rest: GitHubClient['rest'],
    graphql: GitHubClient['graphql'],
    parentId: string,
    childNodeId: string,
  ): Promise<void> {
    const parent = await rest.issues.get({
      owner: this.repo.owner,
      repo: this.repo.repo,
      issue_number: toIssueNumber(parentId),
    })
    await graphql(ADD_SUB_ISSUE_MUTATION, {
      issueId: parent.data.node_id,
      subIssueId: childNodeId,
    })
  }

  /**
   * Write-back to the issue. Content fields (title, body, labels, assignee) map to
   * native issue fields. Planning fields (status, due date, priority) depend on
   * whether the issue is on a Projects v2 board:
   *
   * - **On a board** — due/priority/status are written to the project item's
   *   fields via `updateProjectV2ItemFieldValue` / `clearProjectV2ItemFieldValue`,
   *   and status *also* closes/reopens the issue so issue lists stay correct. The
   *   `in-progress` label is never touched (no label inference on boards).
   * - **Off any board** — status falls back to the legacy open/closed + convention
   *   label path; due/priority have no GitHub equivalent and are ignored.
   *
   * Returns the re-hydrated task so the caller reflects GitHub's post-write truth.
   * Edits commit one field at a time (inline auto-save), so these writes never race.
   */
  async updateTask(id: string, patch: Partial<Task>): Promise<Task> {
    const number = toIssueNumber(id)
    const { rest, graphql } = await this.client()
    const base = { owner: this.repo.owner, repo: this.repo.repo, issue_number: number }

    // Only planning writes need to know whether the issue is on a board; skip the
    // round-trip for pure content edits.
    const planningPatch =
      patch.status !== undefined || patch.dueDate !== undefined || patch.priority !== undefined
    const items = planningPatch ? await this.fetchProjectItems(graphql, number) : []
    const onBoard = items.length > 0

    if (patch.status !== undefined) {
      await this.writeStatus(rest, graphql, base, items, patch.status)
    }

    // Due/priority live on the project item — only writable when on a board.
    if (onBoard && patch.dueDate !== undefined) await this.writeDueDate(graphql, items, patch.dueDate)
    if (onBoard && patch.priority !== undefined) await this.writePriority(graphql, items, patch.priority)

    // Content fields → native issue fields. `labels` replaces the whole set
    // (the UI shows every label, so it edits the full set); `assignees` mirrors
    // our single-assignee model.
    const fields: { title?: string; body?: string; labels?: string[]; assignees?: string[] } = {}
    if (patch.title !== undefined) fields.title = patch.title
    if (patch.body !== undefined) fields.body = patch.body
    if (patch.labels !== undefined) fields.labels = patch.labels
    if (patch.assignee !== undefined) fields.assignees = patch.assignee ? [patch.assignee] : []
    if (Object.keys(fields).length > 0) await rest.issues.update({ ...base, ...fields })

    // GitHub's GraphQL endpoint is only eventually consistent with REST writes, so
    // re-hydrating immediately after the update often returns the pre-write issue —
    // which makes a just-applied edit (e.g. a new label) flicker in then vanish in
    // the UI. The REST writes above already succeeded, so trust the fields we wrote
    // over the possibly-stale read for the content we own.
    const task = await this.getTask(id)
    if (fields.title !== undefined) task.title = fields.title
    if (fields.body !== undefined) task.body = fields.body
    if (fields.labels !== undefined) {
      task.labels = fields.labels
      // On a board priority is project-owned, so a label edit must not clobber it.
      if (!onBoard) task.priority = priorityFromLabels(fields.labels)
    }
    if (fields.assignees !== undefined) task.assignee = fields.assignees[0]
    // Overlay the planning writes too, for the same eventual-consistency reason.
    // Status is overlaid on AND off boards — the off-board path writes through
    // REST (state + label) and the stale GraphQL re-read flickers just the same.
    if (patch.status !== undefined) task.status = patch.status
    if (onBoard && patch.dueDate !== undefined) task.dueDate = patch.dueDate || undefined
    if (onBoard && patch.priority !== undefined) task.priority = patch.priority || undefined
    return task
  }

  private async writeStatus(
    rest: GitHubClient['rest'],
    graphql: GitHubClient['graphql'],
    base: IssueMutationBase,
    items: ProjectItemRef[],
    status: TaskStatus,
  ): Promise<void> {
    const onBoard = items.length > 0
    if (onBoard) {
      // Mirror the board status onto open/closed so issue lists stay correct.
      await rest.issues.update({ ...base, state: status === 'done' ? 'closed' : 'open' })
      await this.writeStatusOption(graphql, items, status)
    } else if (status === 'done') {
      await rest.issues.update({ ...base, state: 'closed' })
    } else if (status === 'in_progress') {
      await rest.issues.update({ ...base, state: 'open' })
      await rest.issues.addLabels({ ...base, labels: [IN_PROGRESS_LABEL] })
    } else if (status === 'open') {
      await rest.issues.update({ ...base, state: 'open' })
      // Removing a label that isn't applied 404s — that's a no-op for us.
      await rest.issues.removeLabel({ ...base, name: IN_PROGRESS_LABEL }).catch((err) => {
        if ((err as { status?: number }).status !== 404) throw err
      })
    }
  }

  /** The issue's project items (id + project id) — the write targets. */
  private async fetchProjectItems(
    graphql: GitHubClient['graphql'],
    number: number,
  ): Promise<ProjectItemRef[]> {
    const res = await graphql<IssueProjectItemsResponse>(ISSUE_PROJECT_ITEMS_QUERY, {
      owner: this.repo.owner,
      repo: this.repo.repo,
      number,
    })
    return res.repository.issue?.projectItems.nodes ?? []
  }

  /** Resolve (and memoize) a project's field definitions by convention. */
  private async resolveProjectFields(
    graphql: GitHubClient['graphql'],
    projectId: string,
  ): Promise<ProjectFields> {
    const cached = this.projectFieldsCache.get(projectId)
    if (cached) return cached
    const res = await graphql<ProjectFieldsResponse>(PROJECT_FIELDS_QUERY, { projectId })
    const nodes = res.node?.fields.nodes ?? []
    const fields: ProjectFields = {}
    let firstDate: { id: string } | undefined
    let namedDate: { id: string } | undefined
    for (const f of nodes) {
      if (!f.id || !f.name) continue
      const nameLc = f.name.toLowerCase()
      if (f.dataType === 'SINGLE_SELECT') {
        if (nameLc === 'status') fields.status = { id: f.id, options: f.options ?? [] }
        else if (nameLc === 'priority') fields.priority = { id: f.id, options: f.options ?? [] }
      } else if (f.dataType === 'DATE') {
        if (!firstDate) firstDate = { id: f.id }
        if (!namedDate && DUE_FIELD_RE.test(f.name)) namedDate = { id: f.id }
      }
    }
    fields.due = namedDate ?? firstDate
    this.projectFieldsCache.set(projectId, fields)
    return fields
  }

  /** Write the Status option onto the first item whose project maps `status`. */
  private async writeStatusOption(
    graphql: GitHubClient['graphql'],
    items: ProjectItemRef[],
    status: TaskStatus,
  ): Promise<void> {
    for (const item of items) {
      const fields = await this.resolveProjectFields(graphql, item.project.id)
      const optionId = fields.status?.options.find((o) => statusFromOption(o.name) === status)?.id
      if (fields.status && optionId) {
        await this.setSelect(graphql, item, fields.status.id, optionId)
        return
      }
    }
  }

  /** Set or clear the due-date field on the first item whose project has one. */
  private async writeDueDate(
    graphql: GitHubClient['graphql'],
    items: ProjectItemRef[],
    dueDate: string,
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
  }

  /** Set or clear the Priority option on the first item whose project has it. */
  private async writePriority(
    graphql: GitHubClient['graphql'],
    items: ProjectItemRef[],
    priority: TaskPriority | undefined,
  ): Promise<void> {
    for (const item of items) {
      const fields = await this.resolveProjectFields(graphql, item.project.id)
      if (!fields.priority) continue
      const optionId = priority
        ? fields.priority.options.find((o) => priorityFromOption(o.name) === priority)?.id
        : undefined
      if (optionId) await this.setSelect(graphql, item, fields.priority.id, optionId)
      else await this.clearField(graphql, item, fields.priority.id)
      return
    }
  }

  private async setSelect(
    graphql: GitHubClient['graphql'],
    item: ProjectItemRef,
    fieldId: string,
    singleSelectOptionId: string,
  ): Promise<void> {
    await graphql(SET_PROJECT_FIELD_MUTATION, {
      projectId: item.project.id,
      itemId: item.id,
      fieldId,
      value: { singleSelectOptionId },
    })
  }

  private async clearField(
    graphql: GitHubClient['graphql'],
    item: ProjectItemRef,
    fieldId: string,
  ): Promise<void> {
    await graphql(CLEAR_PROJECT_FIELD_MUTATION, {
      projectId: item.project.id,
      itemId: item.id,
      fieldId,
    })
  }

  /**
   * Post a comment on the issue — used by the "started in Solus" write-back when
   * a session binds to a task. Not part of `TaskProvider` (it's a GitHub-only
   * capability the binding layer calls directly).
   */
  async postComment(id: string, body: string): Promise<TaskCommentData> {
    const { rest } = await this.client()
    const res = await rest.issues.createComment({
      owner: this.repo.owner,
      repo: this.repo.repo,
      issue_number: toIssueNumber(id),
      body,
    })
    return {
      id: String(res.data.id),
      author: res.data.user ? { login: res.data.user.login } : null,
      body: res.data.body ?? body,
      createdAt: res.data.created_at,
    }
  }

  async startTaskWork(id: string, current?: Task): Promise<void> {
    const task = current ?? await this.getTask(id)
    if (task.status !== 'open') return

    const number = toIssueNumber(id)
    const { rest, graphql } = await this.client()
    const base = { owner: this.repo.owner, repo: this.repo.repo, issue_number: number }
    const items = await this.fetchProjectItems(graphql, number)
    await this.writeStatus(rest, graphql, base, items, 'in_progress')
    await rest.issues.createComment({
      ...base,
      body: 'Started working on this in [Solus](https://solus.chat).',
    })
  }

  private async viewerLogin(graphql: GitHubClient['graphql']): Promise<string> {
    const status = await this.auth.status()
    if (status.connected && status.login) return status.login
    const res = await graphql<{ viewer: { login: string } }>(VIEWER_QUERY)
    return res.viewer.login
  }
}

interface ListIssuesResponse {
  repository: {
    issues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
      nodes: IssueNode[]
    }
  }
}

interface GetIssueResponse {
  repository: { issue: IssueNode | null }
}

/**
 * Build a GitHub task provider for a project, auto-detecting `owner/repo` from
 * its `origin` remote — so GitHub needs almost no manual config. Throws when the
 * cwd has no parseable GitHub remote, letting the caller fall back to local.
 */
export async function makeGitHubTaskProvider(cwd: string): Promise<GitHubTaskProvider> {
  const repo = await resolveRepoRef(cwd)
  if (!repo) {
    throw new Error('Could not detect a GitHub repository from the origin remote.')
  }
  log.info(`GitHub task provider bound to ${repo.owner}/${repo.repo}`)
  return new GitHubTaskProvider(repo)
}
