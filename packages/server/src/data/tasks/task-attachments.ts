import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { parseGitHubPullRequestUrl } from '@solus/contracts/providers'
import type {
  TaskAttachments,
  TaskLinkInput,
  TaskLinkKind,
  TaskSessionRole,
} from '@solus/contracts/task-types'
import type { Attribution } from '@solus/contracts/user'
import type { RecordScope } from '../../admission/principal'
import { createLogger } from '../../logger'
import { resolvePullRequestUrl } from '../../providers/pull-request-url'
import { activityFor } from '../activity/activity'
import { resourceLinks } from '../links/schema'
import { scopeClause } from '../scope'
import { sessionIdentityOf } from '../sessions/session-identity'
import { linkSessionPullRequest, unlinkSessionPullRequest } from '../sessions/session-pull-requests'
import { agentAttribution } from '../stored-attribution'
import { readSessionOutputs } from './session-outputs'
import { TASK_ACTIVITY_LIMIT } from './task-activity'
import { claimSessionOutputLink, deleteTaskLink, readTaskLinks, setTaskLinkPin, writeTaskLink, type TaskLinkWrite } from './task-links'
import { deleteSessionLink, taskSessions, writeSessionLink, type SessionLinkDetails } from './task-sessions'
import { assertTaskKey, database, emitChanged, normalizedOptional } from './task-store'

/**
 * The attachments of a task: what Solus owns about it
 * (docs/plans/provider-owned-tasks.md §4.3). Session links, links to works,
 * plans, automations and pull requests, pins, and the activity of those
 * (`linked`, `unlinked`, `session_started`). They key on the task key and need
 * no copy of the task on this host, so a host that never read a task (the
 * organization's Solus API) holds its attachments all the same. An attachment
 * has an organization: the session's for a session link, else the one of who
 * made it. A read names the scope the caller may see.
 */

const log = createLogger('main', 'task-attachments')

const existingPrLinkRowSchema = z.object({
  target_scope: z.string(),
  url: z.string().nullable(),
  title: z.string(),
  origin_session_id: z.string().nullable(),
})
const workingOwnerRowSchema = z.object({ task_id: z.string(), session_id: z.string(), organization_id: z.string() })

interface PrLinkIdentity {
  title: string
  originSessionId: string | null
}

/**
 * Who a pull request link belongs to once the row exists.
 *
 * A system write only reports what one checkout observed, so a second session
 * observing the same pull request must not take the row over: rewriting the
 * title and the origin on every discovery pass makes two mounted checkouts
 * trade the row back and forth, and each trade broadcasts a task change that
 * starts the next pass. User and agent writes are explicit intent, so they
 * stay authoritative and may still fill a gap the system left.
 */
function nextPrLinkIdentity(
  existing: z.infer<typeof existingPrLinkRowSchema>,
  input: { title?: string; originSessionId: string | null; claimsRow: boolean },
): PrLinkIdentity {
  const suppliedTitle = input.title?.trim()
  if (input.claimsRow) {
    return {
      title: suppliedTitle || existing.title,
      originSessionId: input.originSessionId ?? existing.origin_session_id,
    }
  }
  return {
    title: existing.title || suppliedTitle || '',
    originSessionId: existing.origin_session_id ?? input.originSessionId,
  }
}

export interface TaskPullRequestInput {
  number: number
  title?: string
  url?: string | null
  targetScope: string
  originSessionId?: string | null
  /** Solus made the link by itself, so it is recorded as the system's. */
  automatic?: boolean
}

/** The links and the activity of a task in `scope`. Needs no copy of the task. */
export async function taskAttachments(scope: RecordScope, taskId: string): Promise<TaskAttachments> {
  assertTaskKey(taskId)
  const db = database()
  return {
    links: await readTaskLinks(db, scope, taskId),
    activity: await activityFor(scope, { kind: 'task', id: taskId }, { limit: TASK_ACTIVITY_LIMIT, db }),
  }
}

/**
 * Link a work, a plan, an automation or a pull request to a task.
 * `organizationId` is where a new link is made; `by` is who linked it: the
 * admitted actor, or the agent that asked.
 */
export async function linkTask(organizationId: string, taskId: string, input: TaskLinkInput, by: Attribution): Promise<void> {
  if (input.kind === 'pr') {
    await linkTaskPullRequest(organizationId, taskId, {
      number: Number(input.targetKey),
      targetScope: input.targetScope ?? '',
      title: input.title,
      url: input.url,
      originSessionId: input.originSessionId,
      automatic: input.automatic,
    }, by)
    return
  }
  // A deliberate link: `TaskLinkInput` cannot name a session's output.
  await linkWorkspaceObject(organizationId, taskId, input, by)
}

/** Shared persistence for the three workspace-owned link kinds. Answers whether anything changed. */
async function linkWorkspaceObject(organizationId: string, taskId: string, input: TaskLinkWrite, by: Attribution): Promise<boolean> {
  assertTaskKey(taskId)
  const changed = await database().transaction(async (db) => {
    const target = {
      kind: input.kind,
      targetScope: input.targetScope ?? '',
      targetKey: input.targetKey,
    }
    const existing = await db.get(sql`
      SELECT 1 AS present FROM ${resourceLinks}
      WHERE resource_links.organization_id = ${organizationId}
        AND resource_links.source_kind = 'task' AND resource_links.source_id = ${taskId} AND resource_links.target_kind = ${target.kind}
        AND resource_links.target_scope = ${target.targetScope} AND resource_links.target_key = ${target.targetKey}
    `)
    // Already linked: the only thing left to say is which artifact the page
    // opens with, and that is a pin, not a second link. A deliberate link
    // of a session's output also makes the link stay when the session leaves.
    if (existing) {
      const claimed = input.outputOfSessionId ? false : await claimSessionOutputLink(db, organizationId, taskId, target)
      const pinChanged = input.pinned === undefined
        ? false
        : await setTaskLinkPin(db, organizationId, taskId, target, input.pinned)
      return claimed || pinChanged
    }
    await writeTaskLink(db, organizationId, taskId, input, by)
    return true
  })
  if (changed) emitChanged(taskId)
  return changed
}

/** Link a pull request to the task itself. Idempotent. A pull request that a
 * session works on is that session's link (`linkSessionPullRequest`), which
 * the task reads and does not copy. */
export async function linkTaskPullRequest(
  organizationId: string,
  taskId: string,
  input: TaskPullRequestInput,
  by: Attribution,
): Promise<void> {
  assertTaskKey(taskId)
  if (!Number.isSafeInteger(input.number) || input.number <= 0) {
    throw new Error('A task pull request needs a positive integer number.')
  }
  const taskLog = log.child({ taskId, prNumber: input.number })
  const suppliedUrl = input.url?.trim() || null
  taskLog.info('task_pr_link_requested', { hasSuppliedUrl: !!suppliedUrl })
  const lookupCwd = input.targetScope.trim()
  if (!suppliedUrl && !lookupCwd) {
    throw new Error(`Task pull request #${input.number} needs a project before Solus can resolve its URL.`)
  }
  const resolvedUrl = suppliedUrl ?? await resolvePullRequestUrl(lookupCwd, input.number)
  const parsedUrl = parseGitHubPullRequestUrl(resolvedUrl)
  if (!parsedUrl || parsedUrl.number !== input.number) {
    taskLog.error('task_pr_link_url_invalid', { url: resolvedUrl })
    throw new Error(`Task pull request #${input.number} needs its full GitHub pull request URL.`)
  }
  const url = parsedUrl.url
  // A project path is only where Solus discovered the PR. The repository is
  // the PR's durable identity, so every entry point must persist one scope.
  const targetScope = [
    parsedUrl.baseRepo.host,
    parsedUrl.baseRepo.owner,
    parsedUrl.baseRepo.repo,
  ].join('/').toLowerCase()
  const targetKey = String(input.number)
  const originSessionId = normalizedOptional(input.originSessionId)
  // The task's compact pull request (`Task.pr`) is read from this edge; nothing else captures it.
  const changed = await database().transaction(async (db) => {
    const existingLink = existingPrLinkRowSchema.nullish().parse(await db.get(sql`
      SELECT resource_links.target_scope, resource_links.url, resource_links.title, resource_links.origin_session_id
      FROM ${resourceLinks}
      WHERE resource_links.organization_id = ${organizationId}
        AND resource_links.source_kind = 'task' AND resource_links.source_id = ${taskId} AND resource_links.target_kind = 'pr'
        AND resource_links.target_key = ${targetKey}
        AND (LOWER(resource_links.target_scope) = LOWER(${targetScope}) OR LOWER(resource_links.url) = LOWER(${url}))
      LIMIT 1
    `))
    if (existingLink) {
      const { title, originSessionId: nextOriginSessionId } = nextPrLinkIdentity(existingLink, {
        title: input.title,
        originSessionId,
        claimsRow: !input.automatic,
      })
      const needsLinkUpdate = existingLink.target_scope !== targetScope
        || existingLink.url !== url
        || existingLink.title !== title
        || existingLink.origin_session_id !== nextOriginSessionId
      if (needsLinkUpdate) {
        await db.run(sql`
          UPDATE ${resourceLinks}
          SET target_scope = ${targetScope}, url = ${url}, title = ${title}, origin_session_id = ${nextOriginSessionId},
            repository = ${targetScope}, number = ${input.number}
          WHERE resource_links.organization_id = ${organizationId}
            AND resource_links.source_kind = 'task' AND resource_links.source_id = ${taskId} AND resource_links.target_kind = 'pr'
            AND resource_links.target_scope = ${existingLink.target_scope} AND resource_links.target_key = ${targetKey}
        `)
      }
      return needsLinkUpdate
    }

    await writeTaskLink(db, organizationId, taskId, {
      kind: 'pr',
      targetScope,
      targetKey,
      title: input.title?.trim() || undefined,
      url,
      automatic: input.automatic,
      originSessionId,
    }, by)
    return true
  })
  if (changed) {
    emitChanged(taskId)
    taskLog.info('task_pr_linked', { targetScope, url: parsedUrl.url })
  } else {
    taskLog.debug('task_pr_link_unchanged', { targetScope })
  }
}

/** Remove a link of a task in `scope`. The reverse of `linkTask`. */
export async function unlinkTask(
  scope: RecordScope,
  taskId: string,
  kind: TaskLinkKind,
  targetKey: string,
  targetScope: string,
  by: Attribution,
): Promise<void> {
  let removed = await database().transaction((db) => deleteTaskLink(db, scope, taskId, kind, targetKey, targetScope, by))
  // A pull request the task reads through its sessions has no row here:
  // removing it from the task removes it from each session that owns it.
  const number = Number(targetKey)
  if (!removed && kind === 'pr' && Number.isSafeInteger(number)) {
    const owners = (await taskSessions(scope, taskId))[taskId] ?? []
    for (const owner of owners) {
      if (owner.role === 'referenced') continue
      if (await unlinkSessionPullRequest(owner.sessionId, targetScope, number)) removed = true
    }
  }
  if (removed) emitChanged(taskId)
}

/**
 * Attach a task to one session attempt. The link is in the session's
 * organization; `organizationId` is the caller's, for a session that has no
 * record yet.
 */
export async function linkTaskSession(
  organizationId: string,
  taskId: string,
  sessionId: string,
  role: TaskSessionRole = 'working',
  details: SessionLinkDetails = {},
): Promise<void> {
  const isNewLink = await database().transaction((db) => writeSessionLink(db, organizationId, taskId, sessionId, role, details, Date.now()))
  // A session that joins the task brings what it made. Only a first link
  // does this, so an output that a person removed from the task stays removed.
  if (isNewLink && role !== 'referenced') {
    const linkOrganizationId = (await sessionIdentityOf(sessionId))?.organizationId ?? organizationId
    for (const output of await readSessionOutputs(linkOrganizationId, sessionId)) {
      await linkWorkspaceObject(
        linkOrganizationId,
        taskId,
        { ...output, originSessionId: sessionId, outputOfSessionId: sessionId },
        agentAttribution(sessionId),
      ).catch((error) => {
        log.warn('task_session_output_link_failed', {
          taskId,
          sessionId,
          kind: output.kind,
          targetKey: output.targetKey,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
  }
  emitChanged(taskId)
}

/** The reverse of `linkTaskSession`: drop the relationship and record it. */
export async function unlinkTaskSession(scope: RecordScope, taskId: string, sessionId: string, by: Attribution): Promise<void> {
  const removed = await database().transaction((db) => deleteSessionLink(db, scope, taskId, sessionId, by))
  if (removed) emitChanged(taskId)
}

/**
 * Show what a session made on the task the session works on
 * (docs/plans/session-outputs.md). The link follows the session: it leaves
 * the task when the session does. A session with no task is left alone, and
 * the item waits until the session joins one. A session that a task only
 * references brings nothing. Answers the task, or null when the session works
 * on none.
 */
export async function linkSessionOutput(
  scope: RecordScope,
  sessionId: string,
  input: Omit<TaskLinkInput, 'automatic' | 'originSessionId'>,
): Promise<string | null> {
  const owner = workingOwnerRowSchema.nullish().parse(await database().get(sql`
    SELECT resource_links.source_id AS task_id, resource_links.target_key AS session_id, resource_links.organization_id
    FROM ${resourceLinks}
    WHERE ${scopeClause(scope, sql`resource_links.organization_id`)}
      AND resource_links.source_kind = 'task' AND resource_links.target_kind = 'session'
      AND resource_links.target_key = ${sessionId}
      AND resource_links.relation = 'works-on' AND resource_links.status = 'active'
    ORDER BY resource_links.created_at DESC
    LIMIT 1
  `))
  if (!owner) {
    // A task-free session is ordinary, so this is not a warning. It is the
    // only trace a missed artifact link leaves, so it must be greppable.
    log.debug('task_for_session_unresolved', { sessionId })
    return null
  }
  await linkWorkspaceObject(
    owner.organization_id,
    owner.task_id,
    { ...input, originSessionId: sessionId, outputOfSessionId: owner.session_id },
    agentAttribution(sessionId),
  )
  return owner.task_id
}

/**
 * Link a pull request that a session of this task works on. The session
 * owns that link and the task reads it
 * (docs/plans/session-pull-requests.md). Returns false for a session that
 * does not work on this task: the link then belongs on the task itself.
 */
export async function linkWorkingSessionPullRequest(
  scope: RecordScope,
  taskId: string,
  sessionId: string,
  input: { url: string; title?: string },
  by: Attribution,
): Promise<boolean> {
  const works = ((await taskSessions(scope, taskId))[taskId] ?? []).some((link) =>
    link.role !== 'referenced' && link.sessionId === sessionId)
  if (!works) return false
  await linkSessionPullRequest(sessionId, { ...input, source: 'agent', by })
  return true
}
