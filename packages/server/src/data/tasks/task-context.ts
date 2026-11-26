import { clip } from '@solus/contracts/session-exchange'
import type { IssueEpic, IssueLink } from '@solus/contracts/task-types'

/** Characters of the epic's description read_issue returns. The epic is
 *  context for this task, not the work itself; the agent can open the url. */
const EPIC_BODY_LIMIT = 2000

/** Render the task packet appended to the system prompt of every run on a
 *  task-backed session. It names the task and tells the agent to read it,
 *  and nothing that changes while the agent works: the state, body, comments
 *  and links come from read_issue, once, into the transcript. A packet that
 *  changed on every status move or comment would re-send the whole cached
 *  prompt. The title is absent when the task cannot be read; the id still
 *  names it. */
export function formatTaskContext(task: { id: string; title?: string }): string {
  const title = task.title ? ` — "${task.title}"` : ''
  return [
    `[Working On Issue${title} (issue_id: ${task.id})]`,
    `Call read_issue with issue_id "${task.id}" before you start work. It returns the description, state, columns, comments, epic, and linked items. Call it again only to refresh them. It lists session IDs; use read_session for the status and history of a prior attempt.`,
  ].join('\n')
}

/** The epic this task belongs to: one line that names it, then its
 *  description on one indented line, clipped. */
export function formatTaskEpic(epic: IssueEpic): string[] {
  const ref = /^\d+$/.test(epic.externalId) ? `#${epic.externalId}` : epic.externalId
  const lines = [`Epic: ${epic.provider} ${ref} — "${epic.title}" — ${epic.url}`]
  const body = clip(epic.body, EPIC_BODY_LIMIT)
  if (body) lines.push(`  ${body}`)
  return lines
}

/** One linked item as the agent should address it: the id its read tool takes,
 *  the human title, and the live status when the link carries one. */
export function formatTaskLink(link: IssueLink): string {
  const title = link.liveTitle ?? link.title
  const status = link.liveStatus ? ` [${link.liveStatus}]` : ''
  switch (link.kind) {
    case 'work':
      return `work ${link.targetKey} — "${title}"${status} (read_work)`
    case 'plan':
      return `plan ${link.targetScope}__${link.targetKey} — "${title}"${status} (read_plan with session_id "${link.targetScope}")`
    case 'pr':
      // No Solus tool reads a pull request; the code host's own CLI does.
      return `PR #${link.targetKey} — "${title}"${link.url ? ` — ${link.url}` : ''} (gh pr view ${link.targetKey})`
    case 'automation':
      return `automation ${link.targetKey} — "${title}"${status} (read_automations)`
  }
}
