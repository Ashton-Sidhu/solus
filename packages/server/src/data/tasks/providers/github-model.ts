import { z } from 'zod'
import type { TaskEpic, TaskField, TaskPriority, TaskState } from '@solus/contracts/task-types'
import { githubIssueCategory, githubProjectOptionCategory } from '../status-category'
import { MAX_SOURCE_TASKS, type ProviderComment, type ProviderTask, type SourceItem } from './types'

/**
 * The GitHub words of a task: the GraphQL documents, the node shapes they
 * answer, and the mappers to `ProviderTask`. GraphQL (not REST) for reads
 * because one read gives the parent issue and the Projects v2 fields.
 */

const PAGE_SIZE = 50

// ─── GraphQL documents ────────────────────────────────────────────────────────

// A value's `field` is a union; only the common interface gives `name`, which
// is how the Status, Priority and due date fields are found by convention.
const FIELD_VALUES = `
  fieldValues(first: 20) {
    nodes {
      __typename
      ... on ProjectV2ItemFieldDateValue {
        date
        field { ... on ProjectV2FieldCommon { name } }
      }
      ... on ProjectV2ItemFieldSingleSelectValue {
        name
        optionId
        field { ... on ProjectV2FieldCommon { name } }
      }
    }
  }
`

// The fields of an issue that a connection without the `read:project` scope
// can read. A plain repository source needs nothing more.
const ISSUE_BASE_FIELDS = `
  id
  number
  title
  body
  state
  url
  createdAt
  updatedAt
  repository { owner { login } name }
  labels(first: 20) { nodes { name } }
  assignees(first: 5) { nodes { login avatarUrl(size: 40) } }
  parent { number title url }
`

// `projectItems` gives the Projects v2 values of the issue (priority, due date)
// and the field definitions of each Project, which decide `writableFields`.
// GitHub refuses the whole query when the connection lacks `read:project`.
const ISSUE_FIELDS = `
  ${ISSUE_BASE_FIELDS}
  projectItems(first: 10) {
    nodes {
      id
      project { id fields(first: 30) { nodes { ... on ProjectV2FieldCommon { name dataType } } } }
      ${FIELD_VALUES}
    }
  }
`

const DRAFT_FIELDS = `
  id
  title
  body
  createdAt
  updatedAt
  assignees(first: 5) { nodes { login avatarUrl(size: 40) } }
`

/**
 * The issue queries in two variants: with the Projects v2 values of each issue,
 * and without them for a connection that lacks the `read:project` scope
 * (`withoutProjectScope` in `providers/github.ts`).
 */
export interface IssueQueries {
  listIssues: string
  issueByNumber: string
  taskNode: string
}

function issueQueries(issueFields: string, draftFields: string): IssueQueries {
  return {
    listIssues: listIssuesQuery(issueFields),
    issueByNumber: issueByNumberQuery(issueFields),
    taskNode: taskNodeQuery(issueFields, draftFields),
  }
}

const listIssuesQuery = (issueFields: string) => `
  query($owner: String!, $repo: String!, $states: [IssueState!], $cursor: String) {
    repository(owner: $owner, name: $repo) {
      issues(
        first: ${PAGE_SIZE}
        after: $cursor
        states: $states
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes { ${issueFields} }
      }
    }
  }
`

/** One issue by its number, for the read after a write (a `TaskHome` has no node id). */
const issueByNumberQuery = (issueFields: string) => `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        ${issueFields}
        parent { body }
      }
    }
  }
`

/** One task by its stable id: an issue with its comments, or a draft with its board item. */
const taskNodeQuery = (issueFields: string, draftFields: string) => `
  query($id: ID!) {
    node(id: $id) {
      __typename
      ... on Issue {
        ${issueFields}
        parent { body }
        comments(first: 100) {
          totalCount
          nodes { id author { login } body createdAt }
        }
      }
${draftFields}
    }
  }
`

/** The draft branch of the task node query. A draft lives only on a Project,
 *  so a connection without `read:project` cannot read one. */
const DRAFT_NODE_FIELDS = `
      ... on DraftIssue {
        ${DRAFT_FIELDS}
        projectV2Items(first: 1) {
          nodes {
            id
            project { id }
            ${FIELD_VALUES}
          }
        }
      }
`

/** The issue queries with the Projects v2 values: the normal reads. */
export const ISSUE_QUERIES = issueQueries(ISSUE_FIELDS, DRAFT_NODE_FIELDS)
/** The issue queries a connection without `read:project` can run. */
export const PLAIN_ISSUE_QUERIES = issueQueries(ISSUE_BASE_FIELDS, '')

/** One board item with its draft, for a write to a draft (the draft id is not in `TaskHome`). */
export const DRAFT_ITEM_QUERY = `
  query($itemId: ID!) {
    node(id: $itemId) {
      ... on ProjectV2Item {
        id
        project { id }
        ${FIELD_VALUES}
        content { ... on DraftIssue { ${DRAFT_FIELDS} } }
      }
    }
  }
`

export const PROJECT_QUERY = `
  query($owner: String!, $number: Int!, $cursor: String) {
    repositoryOwner(login: $owner) {
      ... on ProjectV2Owner {
        projectV2(number: $number) {
          id
          title
          fields(first: 50) {
            nodes {
              __typename
              ... on ProjectV2FieldCommon { id name dataType }
              ... on ProjectV2SingleSelectField { options { id name } }
            }
          }
          items(first: ${PAGE_SIZE}, after: $cursor) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              ${FIELD_VALUES}
              content {
                __typename
                ... on Issue { ${ISSUE_FIELDS} }
                ... on DraftIssue { ${DRAFT_FIELDS} }
              }
            }
          }
        }
      }
    }
  }
`

/** The field ids and option ids of one Project, which a field write needs. */
export const PROJECT_FIELDS_QUERY = `
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

export const USER_ID_QUERY = `
  query($login: String!) {
    user(login: $login) { id }
  }
`

export const SET_PROJECT_FIELD_MUTATION = `
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
    updateProjectV2ItemFieldValue(
      input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }
    ) { projectV2Item { id } }
  }
`

export const CLEAR_PROJECT_FIELD_MUTATION = `
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
    clearProjectV2ItemFieldValue(
      input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId }
    ) { projectV2Item { id } }
  }
`

export const ADD_DRAFT_MUTATION = `
  mutation($projectId: ID!, $title: String!, $body: String, $assigneeIds: [ID!]) {
    addProjectV2DraftIssue(
      input: { projectId: $projectId, title: $title, body: $body, assigneeIds: $assigneeIds }
    ) {
      projectItem {
        id
        content { ... on DraftIssue { ${DRAFT_FIELDS} } }
      }
    }
  }
`

export const UPDATE_DRAFT_MUTATION = `
  mutation($draftIssueId: ID!, $title: String, $body: String, $assigneeIds: [ID!]) {
    updateProjectV2DraftIssue(
      input: { draftIssueId: $draftIssueId, title: $title, body: $body, assigneeIds: $assigneeIds }
    ) { draftIssue { ${DRAFT_FIELDS} } }
  }
`

export const DELETE_ITEM_MUTATION = `
  mutation($projectId: ID!, $itemId: ID!) {
    deleteProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) { deletedItemId }
  }
`

// ─── GraphQL node shapes ──────────────────────────────────────────────────────

/** One Projects v2 value of an item. A date value has `date`; a single-select
 *  value has `name` and `optionId`; each has the name of its field. */
export interface FieldValueNode {
  __typename: string
  date?: string | null
  name?: string | null
  optionId?: string | null
  field?: { name?: string | null } | null
}

interface FieldValues {
  nodes: Array<FieldValueNode | null>
}

/** A field definition of a Project. A field type that is not a common field gives no name. */
export interface ProjectFieldNode {
  __typename?: string
  id?: string
  name?: string
  dataType?: string
  options?: Array<{ id: string; name: string }>
}

export interface IssueProjectItemNode {
  id: string
  project: { id: string; fields: { nodes: Array<ProjectFieldNode | null> } }
  fieldValues: FieldValues
}

interface AssigneeNodes {
  nodes: Array<{ login: string; avatarUrl: string }>
}

export interface CommentNode {
  id: string
  author: { login: string } | null
  body: string
  createdAt: string
}

export interface IssueNode {
  id: string
  number: number
  title: string
  body: string | null
  state: 'OPEN' | 'CLOSED'
  url: string
  createdAt: string
  updatedAt: string
  /** The repository the issue is in now, which is not the source's after a transfer. */
  repository: { owner: { login: string }; name: string }
  labels: { nodes: Array<{ name: string }> }
  assignees: AssigneeNodes
  /** The epic. Only a read of one task selects `body`. */
  parent: { number: number; title: string; url: string; body?: string | null } | null
  /** Absent when the connection lacks `read:project`: the issue reads as off every board. */
  projectItems?: { nodes: Array<IssueProjectItemNode | null> }
  /** Only in the read of one task by its id. */
  comments?: { totalCount: number; nodes: CommentNode[] }
}

export interface DraftNode {
  id: string
  title: string
  body: string | null
  createdAt: string
  updatedAt: string
  assignees: AssigneeNodes
}

/** A board item as the read of one draft gives it. */
export interface DraftItemNode {
  id: string
  project: { id: string }
  fieldValues: FieldValues
}

export interface ListIssuesResponse {
  repository: {
    issues: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
      nodes: IssueNode[]
    }
  }
}

export interface IssueByNumberResponse {
  repository: { issue: IssueNode | null } | null
}

export interface TaskNodeResponse {
  node:
    | ({ __typename: 'Issue' } & IssueNode)
    | ({ __typename: 'DraftIssue'; projectV2Items: { nodes: Array<DraftItemNode | null> } } & DraftNode)
    | { __typename: 'PullRequest' }
    | null
}

export interface DraftItemResponse {
  /** `content` has no fields when the item is not a draft. */
  node: (DraftItemNode & { content: Partial<DraftNode> | null }) | null
}

export type ProjectItemContent =
  | ({ __typename: 'Issue' } & IssueNode)
  | ({ __typename: 'DraftIssue' } & DraftNode)
  | { __typename: 'PullRequest' }

export interface ProjectItemNode {
  id: string
  fieldValues: FieldValues
  /** Null when the viewer cannot see the content of the item. */
  content: ProjectItemContent | null
}

export interface ProjectResponse {
  repositoryOwner: {
    projectV2?: {
      id: string
      title: string
      fields: { nodes: Array<ProjectFieldNode | null> }
      items: {
        totalCount: number
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
        nodes: Array<ProjectItemNode | null>
      }
    } | null
  } | null
}

export interface ProjectFieldsResponse {
  node: { fields?: { nodes: Array<ProjectFieldNode | null> } } | null
}

export interface UserIdResponse {
  user: { id: string } | null
}

export interface AddDraftResponse {
  addProjectV2DraftIssue: { projectItem: { id: string; content: DraftNode } }
}

export interface UpdateDraftResponse {
  updateProjectV2DraftIssue: { draftIssue: DraftNode }
}

/** The fields of a REST issue that a task needs. The search answer and the
 *  create answer of Octokit each fit it. */
export interface RestIssue {
  node_id: string
  number: number
  title: string
  body?: string | null
  state: string
  html_url: string
  labels: Array<string | { name?: string | null }>
  assignee?: { login: string; avatar_url: string } | null
  created_at: string
  updated_at: string
}

// ─── Projects v2 fields, found by convention ─────────────────────────────────
// Project fields are user-defined, so Solus finds them by type and name.

/** A DATE field is the due date when its name reads like one; else the first
 *  DATE field of the Project is the due date. */
export const DUE_FIELD_RE = /due|target|end|ship/i

// Conventional priority labels → normalized priority. Covers the common schemes
// (`priority: high`, `p1`, bare `urgent`). First match by descending severity wins.
const PRIORITY_LABELS: Array<{ priority: TaskPriority; match: RegExp }> = [
  { priority: 'urgent', match: /^(priority\s*[:/-]?\s*)?(urgent|critical|p0)$/i },
  { priority: 'high', match: /^(priority\s*[:/-]?\s*)?(high|p1)$/i },
  { priority: 'medium', match: /^(priority\s*[:/-]?\s*)?(medium|med|p2)$/i },
  { priority: 'low', match: /^(priority\s*[:/-]?\s*)?(low|p3)$/i },
]

/** The priority of an issue that is on no Project. */
export function priorityFromLabels(labels: string[]): TaskPriority | undefined {
  for (const { priority, match } of PRIORITY_LABELS) {
    if (labels.some((label) => match.test(label.trim()))) return priority
  }
  return undefined
}

/** The names of a Priority field's options (`Urgent`, `P0`, `High`) map as the labels do. */
export function priorityFromOption(name: string): TaskPriority | undefined {
  return priorityFromLabels([name])
}

function presentNodes<Node>(nodes: Array<Node | null>): Node[] {
  return nodes.flatMap((node) => (node ? [node] : []))
}

/** The Status value of a board item: the option's id and name. */
export function statusValueOf(fieldValues: FieldValues): { optionId: string; name: string } | null {
  for (const value of presentNodes(fieldValues.nodes)) {
    if (
      value.__typename === 'ProjectV2ItemFieldSingleSelectValue'
      && value.field?.name?.toLowerCase() === 'status'
      && value.optionId
      && value.name
    ) {
      return { optionId: value.optionId, name: value.name }
    }
  }
  return null
}

/**
 * The priority and the due date of an issue, from its board items. With more
 * than one board, the first item that has a field gives it. The due date
 * prefers a DATE field with a conventional name, then the first DATE value.
 */
function readProjectFields(items: IssueProjectItemNode[]) {
  let priority: TaskPriority | undefined
  let namedDue: string | undefined
  let anyDue: string | undefined
  for (const item of items) {
    for (const value of presentNodes(item.fieldValues.nodes)) {
      if (value.__typename === 'ProjectV2ItemFieldSingleSelectValue' && value.name) {
        if (value.field?.name?.toLowerCase() === 'priority' && priority === undefined) {
          priority = priorityFromOption(value.name)
        }
      } else if (value.__typename === 'ProjectV2ItemFieldDateValue' && value.date) {
        if (anyDue === undefined) anyDue = value.date
        if (namedDue === undefined && DUE_FIELD_RE.test(value.field?.name ?? '')) namedDue = value.date
      }
    }
  }
  return { priority, dueDate: namedDue ?? anyDue }
}

/** The board items of an issue that the viewer can see. */
export function projectItemsOf(node: IssueNode): IssueProjectItemNode[] {
  return node.projectItems ? presentNodes(node.projectItems.nodes) : []
}

/** A GitHub issue takes a priority or a due date only when a Project it is on has that field. */
function issueWritableFields(items: IssueProjectItemNode[]): TaskField[] {
  const fields = items.flatMap((item) => presentNodes(item.project.fields.nodes))
  const writable: TaskField[] = ['title', 'body', 'labels', 'assignee']
  if (fields.some((field) => field.dataType === 'SINGLE_SELECT' && field.name?.toLowerCase() === 'priority')) {
    writable.push('priority')
  }
  if (fields.some((field) => field.dataType === 'DATE')) writable.push('dueDate')
  return writable
}

// ─── Mappers ──────────────────────────────────────────────────────────────────

/** An issue is open or closed. GitHub has no other state of an issue. */
export function issueState(state: 'OPEN' | 'CLOSED'): TaskState {
  return { name: state === 'CLOSED' ? 'Closed' : 'Open', category: githubIssueCategory(state) }
}

/** The parent issue as the epic. A list read has no description. */
function issueEpic(parent: NonNullable<IssueNode['parent']>): TaskEpic {
  return {
    provider: 'github',
    externalId: String(parent.number),
    url: parent.url,
    title: parent.title,
    body: parent.body ?? '',
  }
}

export function issueToTask(node: IssueNode): ProviderTask {
  const labels = node.labels.nodes.map((label) => label.name)
  const owner = node.repository.owner.login
  const repo = node.repository.name
  // On a board the priority and the due date come only from the board item.
  // Off any board the priority comes from the conventional labels.
  const items = projectItemsOf(node)
  const onBoard = items.length > 0
  const planning = readProjectFields(items)
  const assignee = node.assignees.nodes[0]
  return {
    ref: { provider: 'github', id: node.id },
    kind: 'issue',
    reference: `${owner}/${repo}#${node.number}`,
    url: node.url,
    title: node.title,
    body: node.body ?? '',
    state: issueState(node.state),
    assignee: assignee?.login,
    assigneeAvatarUrl: assignee?.avatarUrl,
    labels,
    priority: onBoard ? planning.priority : priorityFromLabels(labels),
    dueDate: planning.dueDate,
    epic: node.parent ? issueEpic(node.parent) : undefined,
    writableFields: issueWritableFields(items),
    home: { provider: 'github', kind: 'issue', owner, repo, number: node.number },
    createdAt: Date.parse(node.createdAt) || undefined,
    updatedAt: Date.parse(node.updatedAt) || 0,
  }
}

/** A draft item of a Project. It has no state of its own: its state is its
 *  Status option on the board. */
export function draftToTask(
  draft: DraftNode,
  item: { projectId: string; itemId: string; statusName: string | null },
): ProviderTask {
  const assignee = draft.assignees.nodes[0]
  return {
    ref: { provider: 'github', id: draft.id },
    kind: 'draft',
    url: null,
    title: draft.title,
    body: draft.body ?? '',
    state: {
      name: item.statusName ?? 'No status',
      category: item.statusName ? githubProjectOptionCategory(item.statusName) : 'open',
    },
    assignee: assignee?.login,
    assigneeAvatarUrl: assignee?.avatarUrl,
    labels: [],
    writableFields: ['title', 'body', 'assignee'],
    home: { provider: 'github', kind: 'draft', projectId: item.projectId, itemId: item.itemId },
    createdAt: Date.parse(draft.createdAt) || undefined,
    updatedAt: Date.parse(draft.updatedAt) || 0,
  }
}

/** A label of a REST issue is its name, or an object with its name. */
const restLabelNameSchema = z.union([
  z.string(),
  z.object({ name: z.string().nullish() }).transform((label) => label.name ?? ''),
])

const ISSUE_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/\d+/

/**
 * A REST issue (a search hit, a create answer) as a task. REST does not give
 * the Projects of an issue, so the task takes no board field and its priority
 * comes from the labels. `repository` is used when the URL does not name one.
 */
export function restIssueToTask(issue: RestIssue, repository: { owner: string; repo: string }): ProviderTask {
  const [, owner = repository.owner, repo = repository.repo] = ISSUE_URL_RE.exec(issue.html_url) ?? []
  const labels = issue.labels.map((label) => restLabelNameSchema.parse(label)).filter(Boolean)
  return {
    ref: { provider: 'github', id: issue.node_id },
    kind: 'issue',
    reference: `${owner}/${repo}#${issue.number}`,
    url: issue.html_url,
    title: issue.title,
    body: issue.body ?? '',
    state: issueState(issue.state === 'closed' ? 'CLOSED' : 'OPEN'),
    assignee: issue.assignee?.login,
    assigneeAvatarUrl: issue.assignee?.avatar_url,
    labels,
    priority: priorityFromLabels(labels),
    writableFields: ['title', 'body', 'labels', 'assignee'],
    home: { provider: 'github', kind: 'issue', owner, repo, number: issue.number },
    createdAt: Date.parse(issue.created_at) || undefined,
    updatedAt: Date.parse(issue.updated_at) || 0,
  }
}

export function commentFromNode(comment: CommentNode): ProviderComment {
  return {
    id: comment.id,
    author: comment.author?.login ?? null,
    body: comment.body,
    createdAt: Date.parse(comment.createdAt) || 0,
  }
}

/** A repository source has two columns, and an issue is in the one of its state. */
export function repoSourceItem(task: ProviderTask): SourceItem {
  return { task, columnId: task.state.category === 'done' ? 'closed' : 'open', itemId: null }
}

/**
 * Collect at most `MAX_SOURCE_TASKS` items of one page. Answers true when the
 * page has one more item than the cap permits.
 */
export function pushToCap(items: SourceItem[], page: SourceItem[]): boolean {
  for (const item of page) {
    if (items.length >= MAX_SOURCE_TASKS) return true
    items.push(item)
  }
  return false
}
