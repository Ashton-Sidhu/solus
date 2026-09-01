import type {
  CandidateTicket,
  ExternalTicketRef,
  NormalizedTaskComment,
  NormalizedTicket,
  TaskCandidateOptions,
  Task,
  TaskStatus,
  TaskSyncField,
  TicketPatch,
} from '@solus/contracts/task-types'
import { adfToMarkdown, markdownToAdf } from '../../atlassian/adf'
import { atlassianRequest, connectedSiteUrl, IGNORED_RESPONSE } from '../../atlassian/api'
import {
  categoryFor,
  changedSearchSchema,
  commentSchema,
  createdIssueSchema,
  escapeJql,
  ISSUE_FIELDS,
  issueSchema,
  issueTypesSchema,
  LIST_FIELDS,
  normalizeComment,
  pagedSearchSchema,
  PRIORITY_TO_JIRA,
  priorityFromJira,
  scopeFor,
  searchSchema,
  statusFromJira,
  taskSyncFailure,
  transitionsSchema,
  type JiraFieldUpdate,
  type JiraIssue,
  type JiraSearchBody,
} from './jira-model'
import { assetReferencesIn, withPublishedAssets, type AssetReference } from '../task-assets'
import { publishedAssetUrl, recordAssetPublication } from '../asset-publications'
import { withTx } from '../../db'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { storedAssetPath } from '../../server/asset-paths'
import type { TaskSyncAdapter } from './types'

/**
 * The Jira half of the one Atlassian connection.
 *
 * Everything Jira-shaped stops here: the `<cloudId>/<projectKey>` scope, the
 * ADF bodies, the priority names, and above all the workflow — Jira has no
 * "set the status" write, only transitions the current status allows, so this
 * adapter reads what is legal and picks one. When nothing legal reaches the
 * target it fails loudly rather than guessing a nearby state.
 */

/** What the attachment endpoint answers: one entry per file sent, each with the
 *  authenticated URL its bytes are served from. */
const attachmentsSchema = z.array(z.object({
  id: z.string(),
  filename: z.string(),
  content: z.string(),
}))

const ATTACHMENT_MIME = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['svg', 'image/svg+xml'],
  ['pdf', 'application/pdf'],
  ['html', 'text/html'],
  ['mp4', 'video/mp4'],
  ['mov', 'video/quicktime'],
])

/** `POST /issue/{key}/attachments`, the one multipart write in the Jira
 *  adapter. Returns the content URL of the attachment just made. */
async function uploadJiraAttachment(cloudId: string, issueKey: string, assetId: string): Promise<string> {
  const bytes = await readFile(storedAssetPath(assetId))
  if (!bytes.length) throw new Error(`Attachment ${assetId} is empty.`)
  const extension = assetId.split('.').pop() ?? ''
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: ATTACHMENT_MIME.get(extension) ?? 'application/octet-stream' }), assetId)
  const attachments = await atlassianRequest(
    {
      product: 'jira',
      cloudId,
      method: 'POST',
      path: `/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`,
      body: form,
      failure: taskSyncFailure,
    },
    attachmentsSchema,
  )
  const url = attachments[0]?.content
  if (!url) throw new Error(`Jira attached ${assetId} but returned no content URL.`)
  return url
}

/** Every attachment is a link: ADF cannot embed a file by URL, and the label
 *  the author wrote is the only thing a reader has to know what it is. */
function jiraAssetMarkdown(reference: AssetReference, url: string): string {
  return `[${reference.label || reference.assetId}](${url})`
}

/** Minutes of overlap on the change window, absorbing JQL's minute granularity
 *  and any clock difference between this machine and Atlassian. */
const CHANGE_WINDOW_OVERLAP_MINUTES = 2
const CHANGED_PAGE_SIZE = 100
const CHANGED_KEY_CAP = 500

export class JiraTaskSyncAdapter implements TaskSyncAdapter {
  readonly id = 'jira' as const
  /**
   * Priority is included. It is a plain Jira field, but it lives on the
   * project's edit screen — a project that hides it rejects the whole write
   * with a field-level reason, which the sync error then names. That is the
   * intended behavior: a priority that cannot be set says so instead of
   * disappearing.
   */
  readonly writableFields: ReadonlySet<TaskSyncField> = new Set([
    'title', 'body', 'status', 'labels', 'priority',
  ])
  readonly statuses = ['todo', 'in_progress', 'in_review', 'done'] as const

  /** The default issue type per project, which every create needs and no
   *  create should re-discover. Disposable: a wrong guess is corrected by a
   *  restart, and the value only changes when a project is reconfigured. */
  private readonly defaultIssueTypeByScope = new Map<string, Promise<string>>()

  /**
   * Jira can name a review state, so `in_review` is its own key rather than
   * being folded into `in_progress`. The cost is stated plainly: in a workflow
   * with no review-named status, an upstream move flattens a local `in_review`
   * to `in_progress` — which is what Jira is actually showing.
   *
   * `done` and `dropped` share a key: the Done category cannot tell "finished"
   * from "abandoned", so a local `dropped` survives an upstream Done.
   */
  statusKey(status: TaskStatus): string {
    if (status === 'done' || status === 'dropped') return 'done'
    if (status === 'in_review') return 'in_review'
    if (status === 'in_progress') return 'in_progress'
    return 'todo'
  }

  /**
   * The link a person clicks, which must address the site by hostname —
   * `api.atlassian.com` is the machine door and needs a bearer token. The
   * external key deliberately carries cloudId instead, so the hostname comes
   * from the live connection, and a site renamed since the link was stored
   * yields the new address rather than a dead one.
   */
  async ticketUrl(
    target: Omit<ExternalTicketRef, 'externalId' | 'url'>,
    externalId: string,
  ): Promise<string> {
    const { cloudId } = scopeFor(target.externalKey)
    const siteUrl = await connectedSiteUrl(cloudId)
    return siteUrl ? `${siteUrl}/browse/${externalId}` : ''
  }

  async fetchTicket(ref: ExternalTicketRef): Promise<NormalizedTicket> {
    const { cloudId } = scopeFor(ref.externalKey)
    const issue = await atlassianRequest(
      {
        product: 'jira',
        cloudId,
        path: `/rest/api/3/issue/${encodeURIComponent(ref.externalId)}`,
        query: { fields: ISSUE_FIELDS },
        failure: taskSyncFailure,
      },
      issueSchema,
    )
    return this.normalize(issue, ref, ref.url || await this.ticketUrl(ref, issue.key))
  }

  async fetchTickets(refs: ExternalTicketRef[]): Promise<NormalizedTicket[]> {
    // Per-link failures stay per-link: the engine records sync state on each
    // one, so a single unreachable issue must not fail the whole poll. The
    // shared Atlassian limiter bounds how many of these are actually open at
    // once, so a large import does not become a burst.
    return Promise.all(refs.map((ref) => this.fetchTicket(ref)))
  }

  /**
   * One JQL query in place of one GET per linked issue.
   *
   * Jira bumps `updated` for a comment as well as a field edit, so this window
   * covers everything the sync engine reads. JQL time is minute-granular and
   * evaluated on Atlassian's clock, hence the overlap: re-examining a couple of
   * minutes of issues costs one larger page, while missing one loses that change
   * for good, because a ticket reported unchanged has its `lastSyncedAt` moved
   * forward.
   */
  async changedSince(
    target: Omit<ExternalTicketRef, 'externalId' | 'url'>,
    since: number,
  ): Promise<Set<string> | null> {
    const { cloudId, projectKey } = scopeFor(target.externalKey)
    const minutes = Math.ceil(Math.max(Date.now() - since, 0) / 60_000) + CHANGE_WINDOW_OVERLAP_MINUTES
    const jql = `project = "${escapeJql(projectKey)}" AND updated >= -${minutes}m ORDER BY updated DESC`
    const changed = new Set<string>()
    let nextPageToken: string | undefined

    do {
      const body: JiraSearchBody = {
        jql,
        maxResults: CHANGED_PAGE_SIZE,
        // Only the key is read. A delta query that carried descriptions and
        // comments would cost more than the per-ticket poll it replaces.
        fields: ['updated'],
      }
      if (nextPageToken) body.nextPageToken = nextPageToken
      const page = await atlassianRequest(
        {
          product: 'jira',
          cloudId,
          method: 'POST',
          path: '/rest/api/3/search/jql',
          body,
          failure: taskSyncFailure,
        },
        changedSearchSchema,
      )
      for (const issue of page.issues) changed.add(issue.key)
      // Past this much churn, enumerating the change set is no cheaper than the
      // per-ticket pass it exists to avoid. Say so instead of paging on.
      if (changed.size > CHANGED_KEY_CAP) return null
      nextPageToken = page.nextPageToken ?? undefined
      if (page.isLast === true) break
    } while (nextPageToken)

    return changed
  }

  async pushFields(ref: ExternalTicketRef, patch: TicketPatch): Promise<NormalizedTicket> {
    const { cloudId } = scopeFor(ref.externalKey)
    const fields: JiraFieldUpdate = {}
    if (patch.title !== undefined) fields.summary = patch.title
    if (patch.body !== undefined) fields.description = markdownToAdf(patch.body)
    if (patch.labels !== undefined) fields.labels = patch.labels
    if (patch.priority !== undefined) {
      fields.priority = patch.priority ? { name: PRIORITY_TO_JIRA[patch.priority] } : null
    }

    if (Object.keys(fields).length) {
      await atlassianRequest(
        {
          product: 'jira',
          cloudId,
          method: 'PUT',
          path: `/rest/api/3/issue/${encodeURIComponent(ref.externalId)}`,
          body: { fields },
          failure: taskSyncFailure,
        },
        IGNORED_RESPONSE,
      )
    }
    if (patch.status !== undefined) await this.transitionTo(ref, patch.status)
    return this.fetchTicket(ref)
  }

  /**
   * Move an issue by workflow transition, because Jira has no other way to set
   * a status. Any transition whose destination lands in the target category
   * will do; a review-named destination wins when the target is `in_review`, so
   * a workflow that models review is used as it was designed.
   */
  private async transitionTo(ref: ExternalTicketRef, status: TaskStatus): Promise<void> {
    const { cloudId } = scopeFor(ref.externalKey)
    const path = `/rest/api/3/issue/${encodeURIComponent(ref.externalId)}/transitions`
    const { transitions } = await atlassianRequest(
      { product: 'jira', cloudId, path, failure: taskSyncFailure },
      transitionsSchema,
    )
    const target = categoryFor(status)
    const legal = transitions.filter((transition) => transition.to.statusCategory.key === target)
    if (!legal.length) {
      // Guessing a nearby state would silently put the issue somewhere the user
      // did not ask for, and the task board would then report a status Jira
      // does not hold. Fail instead, and name what is missing.
      throw new Error(
        `No Jira transition from ${ref.externalId}'s current status reaches ${status}. Adjust the workflow or move the issue in Jira.`,
      )
    }
    const preferred = status === 'in_review'
      ? legal.find((transition) => /review|qa|verif/i.test(transition.to.name))
      : undefined
    await atlassianRequest(
      {
        product: 'jira',
        cloudId,
        method: 'POST',
        path,
        body: { transition: { id: (preferred ?? legal[0]).id } },
        failure: taskSyncFailure,
      },
      IGNORED_RESPONSE,
    )
  }

  async postComment(ref: ExternalTicketRef, body: string): Promise<NormalizedTaskComment> {
    const { cloudId } = scopeFor(ref.externalKey)
    const comment = await atlassianRequest(
      {
        product: 'jira',
        cloudId,
        method: 'POST',
        path: `/rest/api/3/issue/${encodeURIComponent(ref.externalId)}/comment`,
        body: { body: markdownToAdf(body) },
        failure: taskSyncFailure,
      },
      commentSchema,
    )
    return normalizeComment(comment)
  }

  /** Jira attaches any file to an issue; the store's own 10 MB cap is the
   *  same as Jira's default attachment limit, so nothing is refused here. */
  unpublishableAssets(_body: string): AssetReference[] {
    return []
  }

  /**
   * Jira attaches files to the issue, not to the body, so a published
   * reference becomes a link to the attachment's content URL — ADF has no
   * way to embed an attachment by URL, and the attachment panel shows the
   * picture either way. A publication is recorded per issue, because that is
   * where the bytes live: the same still on two issues uploads twice, and on
   * one issue once, however many retries the sync engine makes.
   */
  async publishAssets(ref: ExternalTicketRef, body: string): Promise<string> {
    const references = assetReferencesIn(body)
    if (!references.length) return body
    const { cloudId } = scopeFor(ref.externalKey)
    const target = `${cloudId}/${ref.externalId}`
    const urlByAssetId = new Map<string, string>()
    for (const assetId of new Set(references.map((reference) => reference.assetId))) {
      const published = publishedAssetUrl(assetId, this.id, target)
      if (published) {
        urlByAssetId.set(assetId, published)
        continue
      }
      const url = await uploadJiraAttachment(cloudId, ref.externalId, assetId)
      // Record before the body is sent. An upload cannot be undone, so a failure
      // after this point must not cost a second one when the caller retries.
      withTx(() => recordAssetPublication(assetId, this.id, target, url))
      urlByAssetId.set(assetId, url)
    }
    return withPublishedAssets(body, urlByAssetId, jiraAssetMarkdown)
  }

  async createTicket(
    target: Omit<ExternalTicketRef, 'externalId' | 'url'>,
    patch: Required<Pick<TicketPatch, 'title'>> & TicketPatch,
  ): Promise<NormalizedTicket> {
    const { cloudId, projectKey } = scopeFor(target.externalKey)
    const issueTypeId = await this.defaultIssueType(target.externalKey)
    const fields: JiraFieldUpdate & { project: { key: string }; issuetype: { id: string } } = {
      project: { key: projectKey },
      issuetype: { id: issueTypeId },
      summary: patch.title,
    }
    if (patch.body !== undefined) fields.description = markdownToAdf(patch.body)
    if (patch.labels?.length) fields.labels = patch.labels
    if (patch.priority) fields.priority = { name: PRIORITY_TO_JIRA[patch.priority] }

    const created = await atlassianRequest(
      {
        product: 'jira',
        cloudId,
        method: 'POST',
        path: '/rest/api/3/issue',
        body: { fields },
        failure: taskSyncFailure,
      },
      createdIssueSchema,
    )
    const ref: ExternalTicketRef = {
      provider: 'jira',
      externalKey: target.externalKey,
      externalId: created.key,
      url: await this.ticketUrl(target, created.key),
    }
    // A new issue starts wherever the workflow starts. Only a status that is
    // not already that needs the extra transition.
    if (patch.status && categoryFor(patch.status) !== 'new') {
      await this.transitionTo(ref, patch.status)
    }
    return this.fetchTicket(ref)
  }

  private defaultIssueType(externalKey: string): Promise<string> {
    const cached = this.defaultIssueTypeByScope.get(externalKey)
    if (cached) return cached
    const pending = this.readDefaultIssueType(externalKey)
    this.defaultIssueTypeByScope.set(externalKey, pending)
    return pending
  }

  private async readDefaultIssueType(externalKey: string): Promise<string> {
    const { cloudId, projectKey } = scopeFor(externalKey)
    try {
      const { issueTypes } = await atlassianRequest(
        {
          product: 'jira',
          cloudId,
          path: `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,
          failure: taskSyncFailure,
        },
        issueTypesSchema,
      )
      // A subtask cannot be created without a parent, so it is never the
      // default for a task Solus is publishing on its own.
      const usable = issueTypes.find((type) => !type.subtask)
      if (!usable) throw new Error(`Jira project ${projectKey} has no issue type Solus can create.`)
      return usable.id
    } catch (error) {
      // A failed read must not be remembered, or one bad moment makes the
      // project unpublishable for the rest of the process.
      this.defaultIssueTypeByScope.delete(externalKey)
      throw error
    }
  }

  async listCandidates(
    target: Omit<ExternalTicketRef, 'externalId' | 'url'>,
    options: TaskCandidateOptions = {},
  ): Promise<CandidateTicket[]> {
    const { cloudId, projectKey } = scopeFor(target.externalKey)
    const limit = Math.max(1, Math.min(options.limit ?? 100, 200))
    const query = options.query?.trim()
    // `~` is Jira's text match; the escaped quotes keep a query with spaces
    // from being read as JQL syntax.
    const jql = [
      `project = "${escapeJql(projectKey)}"`,
      query ? `AND (summary ~ "${escapeJql(query)}" OR key = "${escapeJql(query)}")` : '',
      'ORDER BY updated DESC',
    ].filter(Boolean).join(' ')

    const { issues } = await atlassianRequest(
      {
        product: 'jira',
        cloudId,
        method: 'POST',
        path: '/rest/api/3/search/jql',
        body: { jql, maxResults: limit, fields: LIST_FIELDS },
        failure: taskSyncFailure,
      },
      searchSchema,
    )
    const siteUrl = await connectedSiteUrl(cloudId)
    return issues.map((issue) => ({
      provider: 'jira' as const,
      externalKey: target.externalKey,
      externalId: issue.key,
      url: siteUrl ? `${siteUrl}/browse/${issue.key}` : '',
      title: issue.fields.summary ?? issue.key,
      status: statusFromJira(issue.fields.status.statusCategory.key, issue.fields.status.name),
      labels: issue.fields.labels ?? [],
      externalUpdatedAt: new Date(issue.fields.updated).toISOString(),
      priorityHint: priorityFromJira(issue.fields.priority?.name),
    }))
  }

  async listTickets(
    target: Omit<ExternalTicketRef, 'externalId' | 'url'>,
    options: TaskCandidateOptions = {},
  ): Promise<{ tasks: Task[]; truncated?: boolean }> {
    const { cloudId, projectKey } = scopeFor(target.externalKey)
    const cap = 200
    const pageSize = 50
    const issues: JiraIssue[] = []
    const involvement = options.involvement ?? 'all'
    const involvementClause = {
      all: '',
      assigned: 'AND assignee = currentUser()',
      authored: 'AND reporter = currentUser()',
      mentioned: null,
      review_requested: null,
    }[involvement]
    if (involvementClause === null) {
      throw new Error(`Jira cannot express ${involvement.replace('_', ' ')} involvement for issues.`)
    }
    // A project past the cap cannot be searched by filtering the page Solus
    // happens to hold: the issue being looked for is usually an older one. The
    // text goes to Jira, which searches the whole project.
    const query = options.query?.trim()
    const queryClause = query
      ? `AND (summary ~ "${escapeJql(query)}" OR key = "${escapeJql(query)}")`
      : ''
    let nextPageToken: string | undefined
    let truncated = false

    do {
      const body: JiraSearchBody = {
        jql: [
          `project = "${escapeJql(projectKey)}"`,
          involvementClause,
          queryClause,
          'ORDER BY updated DESC',
        ].filter(Boolean).join(' '),
        maxResults: Math.min(pageSize, cap - issues.length),
        fields: LIST_FIELDS,
      }
      if (nextPageToken) body.nextPageToken = nextPageToken
      const page = await atlassianRequest(
        {
          product: 'jira',
          cloudId,
          method: 'POST',
          path: '/rest/api/3/search/jql',
          body,
          failure: taskSyncFailure,
        },
        pagedSearchSchema,
      )
      issues.push(...page.issues)
      nextPageToken = page.nextPageToken ?? undefined
      if (issues.length >= cap && (nextPageToken || page.isLast === false)) {
        truncated = true
        break
      }
      if (page.isLast === true || !nextPageToken) break
    } while (issues.length < cap)

    const siteUrl = await connectedSiteUrl(cloudId)
    const tasks = issues.slice(0, cap).map((issue) => this.taskFromIssue(
      issue,
      siteUrl ? `${siteUrl}/browse/${issue.key}` : '',
    ))
    return truncated ? { tasks, truncated: true } : { tasks }
  }

  /**
   * A browse row. Deliberately without `raw`: the provider payload it used to
   * carry was a second copy of the whole issue, on every row, cached as JSON and
   * sent to every client — and no surface read it. A ticket's detail view
   * fetches the issue itself, which is where the full payload belongs.
   */
  private taskFromIssue(issue: JiraIssue, url: string): Task {
    return {
      id: issue.key,
      providerId: 'jira',
      kind: 'task',
      title: issue.fields.summary ?? issue.key,
      body: adfToMarkdown(issue.fields.description),
      status: statusFromJira(issue.fields.status.statusCategory.key, issue.fields.status.name),
      url,
      labels: issue.fields.labels ?? [],
      priority: priorityFromJira(issue.fields.priority?.name),
      updatedAt: Date.parse(issue.fields.updated),
    }
  }

  private normalize(issue: JiraIssue, ref: ExternalTicketRef, url: string): NormalizedTicket {
    return {
      ...ref,
      externalId: issue.key,
      url,
      title: issue.fields.summary ?? issue.key,
      body: adfToMarkdown(issue.fields.description),
      status: statusFromJira(issue.fields.status.statusCategory.key, issue.fields.status.name),
      labels: issue.fields.labels ?? [],
      externalUpdatedAt: new Date(issue.fields.updated).toISOString(),
      comments: (issue.fields.comment?.comments ?? []).map(normalizeComment),
      snapshot: issue,
      priorityHint: priorityFromJira(issue.fields.priority?.name),
    }
  }
}
