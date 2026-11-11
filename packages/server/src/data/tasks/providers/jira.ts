import { readFile } from 'node:fs/promises'
import type { TaskRef, TaskStatusCategory } from '@solus/contracts/task-sources'
import type { TaskAssigneeCandidate, TaskEpic, TaskUpdatePatch } from '@solus/contracts/task-types'
import { adfToMarkdown, markdownToAdf } from '../../../atlassian/adf'
import { createLogger } from '../../../logger'
import { storedAssetPath } from '../../assets/asset-paths'
import { publishedAssetUrl, recordAssetPublication } from '../asset-publications'
import { jiraStatusCategory } from '../status-category'
import { assetReferencesIn, withPublishedAssets, type AssetReference } from '../task-assets'
import {
  attachmentsSchema,
  commentFromJira,
  commentSchema,
  createdIssueSchema,
  epicIssueSchema,
  IGNORED_RESPONSE,
  ISSUE_FIELDS,
  issueSchema,
  issueToTask,
  issueTypesSchema,
  parentEpic,
  PRIORITY_TO_JIRA,
  transitionsSchema,
  type JiraFieldUpdate,
  type JiraIssue,
  type JiraTransitionTarget,
} from './jira-model'
import type {
  JiraTransport,
  ProviderComment,
  ProviderTask,
  ProviderTaskDetails,
  TaskDraft,
  TaskHome,
  TaskProviderAdapter,
} from './types'

const log = createLogger('main', 'jira-task-provider')

type JiraHome = Extract<TaskHome, { provider: 'jira' }>

function jiraHome(home: TaskHome): JiraHome {
  if (home.provider !== 'jira') throw new Error(`The Jira task provider cannot write to a ${home.provider} task.`)
  return home
}

function issuePath(idOrKey: string): string {
  return `/rest/api/3/issue/${encodeURIComponent(idOrKey)}`
}

/**
 * The parent of the issue as its epic, with the description the agent reads.
 * The issue answer has only the key and the summary of the parent, so the
 * description is one more read. Jira Cloud gives an epic through `parent` for
 * each project type, so the retired Epic Link field is not read.
 */
async function readEpic(
  jira: JiraTransport,
  cloudId: string,
  issue: JiraIssue,
  siteUrl: string | null,
): Promise<TaskEpic | undefined> {
  const named = parentEpic(issue, siteUrl)
  if (!named) return undefined
  try {
    const epic = await jira.request(
      { cloudId, path: issuePath(named.externalId), query: { fields: 'summary,description' } },
      epicIssueSchema,
    )
    return { ...named, title: epic.fields.summary ?? named.title, body: adfToMarkdown(epic.fields.description) }
  } catch (error) {
    // An epic the person cannot read must not fail the read of an issue they
    // can. The task still names the epic; only the description is absent.
    log.warn('jira_epic_read_failed', {
      issueKey: issue.key,
      epicKey: named.externalId,
      error: error instanceof Error ? error.message : String(error),
    })
    return named
  }
}

/** Read one issue by its numeric id or its key, with its comments and its epic. */
export async function readJiraTask(jira: JiraTransport, cloudId: string, idOrKey: string): Promise<ProviderTaskDetails> {
  const issue = await jira.request({ cloudId, path: issuePath(idOrKey), query: { fields: ISSUE_FIELDS } }, issueSchema)
  const siteUrl = await jira.siteUrl(cloudId)
  const comments = issue.fields.comment?.comments ?? []
  return {
    task: { ...issueToTask(issue, cloudId, siteUrl), epic: await readEpic(jira, cloudId, issue, siteUrl) },
    comments: comments.map(commentFromJira),
    commentsTruncated: (issue.fields.comment?.total ?? 0) > comments.length,
  }
}

/**
 * Move an issue by a workflow transition: Jira has no other write of a status.
 * Only a transition that the current status permits is legal. When no legal
 * transition has a destination that `accepts`, this fails loudly. A guess of a
 * near state would put the issue where nobody asked, and Solus would then show
 * a status that Jira does not hold.
 */
export async function transitionJiraIssue(
  jira: JiraTransport,
  home: JiraHome,
  accepts: (to: JiraTransitionTarget) => boolean,
  targetName: string,
): Promise<void> {
  const path = `${issuePath(home.key)}/transitions`
  const { transitions } = await jira.request({ cloudId: home.cloudId, path }, transitionsSchema)
  const legal = transitions.find((transition) => accepts(transition.to))
  if (!legal) {
    throw new Error(
      `No Jira transition from ${home.key}'s current status reaches ${targetName}. Adjust the workflow or move the issue in Jira.`,
    )
  }
  await jira.request(
    { cloudId: home.cloudId, method: 'POST', path, body: { transition: { id: legal.id } } },
    IGNORED_RESPONSE,
  )
}

/**
 * Create an issue with the default issue type of the project, and answer it as
 * a task. `statusIds` names the statuses of the column to start in: a new
 * issue starts where the workflow starts, so only a different status needs a
 * transition.
 */
export async function createJiraTask(
  jira: JiraTransport,
  input: { cloudId: string; projectKey: string; draft: TaskDraft; statusIds: string[] | null; columnName: string },
): Promise<ProviderTask> {
  const { cloudId, projectKey, draft, statusIds } = input
  if (draft.assignee || draft.dueDate) {
    throw new Error('Solus cannot set the assignee or the due date of a Jira issue. Set them in Jira.')
  }
  const { issueTypes } = await jira.request(
    { cloudId, path: `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes` },
    issueTypesSchema,
  )
  // A subtask cannot be created without a parent, so it is never the default
  // type of a task that Solus creates.
  const issueType = issueTypes.find((type) => !type.subtask)
  if (!issueType) throw new Error(`Jira project ${projectKey} has no issue type Solus can create.`)

  const fields: JiraFieldUpdate & { project: { key: string }; issuetype: { id: string } } = {
    project: { key: projectKey },
    issuetype: { id: issueType.id },
    summary: draft.title,
  }
  if (draft.body !== undefined) fields.description = markdownToAdf(draft.body)
  if (draft.labels?.length) fields.labels = draft.labels
  if (draft.priority) fields.priority = { name: PRIORITY_TO_JIRA[draft.priority] }
  const created = await jira.request(
    { cloudId, method: 'POST', path: '/rest/api/3/issue', body: { fields } },
    createdIssueSchema,
  )
  const { task } = await readJiraTask(jira, cloudId, created.key)
  if (!statusIds || (task.stateId && statusIds.includes(task.stateId))) return task
  await transitionJiraIssue(
    jira,
    { provider: 'jira', cloudId, key: created.key },
    (to) => statusIds.includes(to.id),
    input.columnName,
  )
  return (await readJiraTask(jira, cloudId, created.key)).task
}

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

/** Each attachment is a link: ADF cannot embed a file by URL, and the label
 *  the author wrote is the only thing that tells a reader what it is. */
function jiraAssetMarkdown(reference: AssetReference, url: string): string {
  return `[${reference.label || reference.assetId}](${url})`
}

/**
 * The Jira half of the one Atlassian connection. Everything Jira-shaped stops
 * here: the ADF bodies, the priority names, and the workflow. Jira has no
 * "set the status" write, only the transitions the current status permits.
 */
export class JiraTaskProvider implements TaskProviderAdapter {
  readonly id = 'jira' as const

  constructor(private readonly jira: JiraTransport) {}

  async fetch(ref: TaskRef): Promise<ProviderTaskDetails> {
    if (ref.provider !== 'jira') throw new Error(`The Jira task provider cannot read a ${ref.provider} task.`)
    return readJiraTask(this.jira, ref.cloudId, ref.id)
  }

  async update(home: TaskHome, patch: TaskUpdatePatch): Promise<ProviderTask> {
    const { cloudId, key } = jiraHome(home)
    if (patch.assignee !== undefined || patch.dueDate !== undefined) {
      throw new Error('Solus cannot change the assignee or the due date of a Jira issue. Change them in Jira.')
    }
    const fields: JiraFieldUpdate = {}
    if (patch.title !== undefined) fields.summary = patch.title
    if (patch.body !== undefined) fields.description = markdownToAdf(patch.body)
    if (patch.labels !== undefined) fields.labels = patch.labels
    if (patch.priority !== undefined) {
      fields.priority = patch.priority ? { name: PRIORITY_TO_JIRA[patch.priority] } : null
    }
    if (Object.keys(fields).length) {
      await this.jira.request({ cloudId, method: 'PUT', path: issuePath(key), body: { fields } }, IGNORED_RESPONSE)
    }
    return (await readJiraTask(this.jira, cloudId, key)).task
  }

  /** A transition to a status of the category. Each such destination is good. */
  async setState(home: TaskHome, category: TaskStatusCategory): Promise<ProviderTask> {
    const target = jiraHome(home)
    await transitionJiraIssue(
      this.jira,
      target,
      (to) => jiraStatusCategory(to.statusCategory.key) === category,
      category,
    )
    return (await readJiraTask(this.jira, target.cloudId, target.key)).task
  }

  async comment(home: TaskHome, body: string): Promise<ProviderComment> {
    const { cloudId, key } = jiraHome(home)
    const comment = await this.jira.request(
      { cloudId, method: 'POST', path: `${issuePath(key)}/comment`, body: { body: markdownToAdf(body) } },
      commentSchema,
    )
    return commentFromJira(comment)
  }

  /** Solus does not write the assignee of a Jira issue, so it lists no candidates. */
  async assignees(home: TaskHome): Promise<TaskAssigneeCandidate[]> {
    jiraHome(home)
    return []
  }

  /** Jira attaches each file type to an issue, and the 10 MB cap of the asset
   *  store is the default attachment limit of Jira, so nothing is refused. */
  unpublishableAssets(home: TaskHome, _body: string): AssetReference[] {
    jiraHome(home)
    return []
  }

  /**
   * Jira attaches files to the issue, not to the body, so a published
   * reference becomes a link to the content URL of the attachment. A
   * publication is recorded for each issue, because the bytes are there: one
   * picture on two issues uploads two times, and on one issue one time, for
   * each number of retries.
   */
  async publishAssets(home: TaskHome, body: string): Promise<string> {
    const { cloudId, key } = jiraHome(home)
    const references = assetReferencesIn(body)
    if (!references.length) return body
    const target = `${cloudId}/${key}`
    const urlByAssetId = new Map<string, string>()
    for (const assetId of new Set(references.map((reference) => reference.assetId))) {
      const published = await publishedAssetUrl(assetId, this.id, target)
      if (published) {
        urlByAssetId.set(assetId, published)
        continue
      }
      const url = await this.uploadAttachment(cloudId, key, assetId)
      // Record before the body is sent. An upload cannot be undone, so a failure
      // after this point must not cost a second one when the caller retries.
      await recordAssetPublication(assetId, this.id, target, url)
      urlByAssetId.set(assetId, url)
    }
    return withPublishedAssets(body, urlByAssetId, jiraAssetMarkdown)
  }

  /** `POST /issue/{key}/attachments`, the one multipart write to Jira.
   *  Answers the content URL of the new attachment. */
  private async uploadAttachment(cloudId: string, key: string, assetId: string): Promise<string> {
    const bytes = await readFile(storedAssetPath(assetId))
    if (!bytes.length) throw new Error(`Attachment ${assetId} is empty.`)
    const extension = assetId.split('.').pop() ?? ''
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: ATTACHMENT_MIME.get(extension) ?? 'application/octet-stream' }), assetId)
    const attachments = await this.jira.request(
      { cloudId, method: 'POST', path: `${issuePath(key)}/attachments`, body: form },
      attachmentsSchema,
    )
    const url = attachments[0]?.content
    if (!url) throw new Error(`Jira attached ${assetId} but returned no content URL.`)
    return url
  }

  async remove(home: TaskHome): Promise<void> {
    jiraHome(home)
    throw new Error('A Jira issue cannot be deleted from Solus.')
  }
}
