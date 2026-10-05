import { clip } from '@solus/contracts/session-exchange'
import type { TaskEpic, TaskLink, TaskSessionRole } from '@solus/contracts/task-types'
import type { AgentTaskLifecyclePolicy } from '@solus/contracts/types'
import type { PersonalSettings } from '@solus/contracts/settings'

/** Characters of the epic's description read_task returns. The epic is
 *  context for this task, not the work itself; the agent can open the url. */
const EPIC_BODY_LIMIT = 2000

/**
 * The rules appended to the packet of the task's lead: the one session the task
 * is talked to through (docs/plans/task-conversation.md). The lead
 * coordinates workers and keeps its own thread small, so a cache miss on a long
 * thread does not spend the user's limits.
 */
const LEAD_CONTRACT = [
  'Lead contract:',
  '- You are the lead session of this task. You coordinate; you do not implement beyond very small edits.',
  '- Start workers with start_session (task=\'attempt\', this task\'s id), one worktree each (worktree_base_branch), with the full brief in the prompt. A worker does not see this conversation.',
  '- Keep report on and do not poll. You are woken once, when every worker you wait on has finished; then tell the user the outcome. The user answers workers\' questions and permissions on their cards.',
  '- Answer the user from reports, read_task_sessions and linked items. Do not read transcripts or source files to answer; ask a worker instead.',
  '- Send a follow-up to a worker with report off unless you need its answer. Do not relay findings between workers; put shared findings in a task comment.',
  '- Keep this thread small: short reads, short replies. Say what happened, what was produced with its link, and what is open.',
  '- Write durable summaries into the task body or a task comment, not only into this conversation.',
  '- When the user writes to you, call read_task_sessions first. After session reports, do not: they already say what each worker did.',
]

/** The user's settings for a task's lead (Settings → Tasks). They extend the
 *  lead contract; they never replace it. */
export type LeadSettings = Pick<PersonalSettings, 'leadInstructions' | 'workerModel'>

const NO_LEAD_SETTINGS: LeadSettings = { leadInstructions: '', workerModel: null }

/** Render the task packet appended to the system prompt of every run on a
 *  task-backed session. It names the task and the rules the agent works under,
 *  and nothing that changes while the agent works: the status, body, comments
 *  and links come from read_task, once, into the transcript. A packet that
 *  changed on every status move or comment would re-send the whole cached
 *  prompt. The title is absent when the task cannot be read; the id still
 *  names it. `role` is the session's own link role; the lead's packet ends
 *  with the lead contract and then the user's lead settings. */
export function formatTaskContext(
  task: { id: string; title?: string },
  lifecyclePolicy: AgentTaskLifecyclePolicy = 'moderate',
  role: TaskSessionRole = 'working',
  lead: LeadSettings = NO_LEAD_SETTINGS,
): string {
  const title = task.title ? ` — "${task.title}"` : ''
  return [
    `[Working On Task${title} (task_id: ${task.id})]`,
    `Call read_task with task_id "${task.id}" before you start work. It returns the description, comments, epic, and linked items. Call it again only to refresh them. Call read_task_sessions to see prior attempts.`,
    '',
    'Work contract:',
    ...workContract(lifecyclePolicy, role),
    ...(role === 'lead' ? leadSettingsLines(lead) : []),
  ].join('\n')
}

/** The user's lead settings, after the lead contract. A worker model is a
 *  default only: the user's instructions can route work elsewhere. */
function leadSettingsLines(lead: LeadSettings): string[] {
  const lines: string[] = []
  if (lead.workerModel) {
    const { provider, model, reasoningEffort } = lead.workerModel
    const reasoning = reasoningEffort ? ` and reasoning_effort '${reasoningEffort}'` : ''
    lines.push(`- When the user's instructions name no agent and model for a worker, start it with agent_provider '${provider}', model_id '${model}'${reasoning}.`)
  }
  const instructions = lead.leadInstructions.trim()
  if (instructions) lines.push('', 'User lead instructions:', instructions)
  return lines
}

/** The rules the agent works under: the lifecycle policy's, then the lead's
 *  for the task's lead. */
function workContract(lifecyclePolicy: AgentTaskLifecyclePolicy, role: TaskSessionRole): string[] {
  const lines: string[] = []
  if (lifecyclePolicy === 'none') {
    lines.push(
      '- Do not change this task\'s status. The user controls its lifecycle.',
      '- Leave a task comment when blocked or when durable handoff context matters.',
      '- Use comment_task for durable write-back.',
    )
  } else if (lifecyclePolicy === 'moderate') {
    lines.push(
      '- Keep this task in progress while you work.',
      '- Leave a task comment when blocked or when durable handoff context matters.',
      '- Move the task to in_review when a pull request is ready for a human. Do not move it to done; the user closes completed work.',
      '- Use comment_task and update_task_status for permitted durable write-back.',
    )
  } else {
    lines.push(
      '- Keep this task in progress while you work.',
      '- Leave a task comment when blocked or when durable handoff context matters.',
      '- Move the task to in_review when a pull request is ready for a human, or done when the work is complete without review.',
      '- Use comment_task and update_task_status for durable write-back.',
    )
  }
  if (role === 'lead') lines.push('', ...LEAD_CONTRACT)
  return lines
}

/** The upstream epic this task belongs to: one line that names it, then its
 *  description on one indented line, clipped. */
export function formatTaskEpic(epic: TaskEpic): string[] {
  const ref = /^\d+$/.test(epic.externalId) ? `#${epic.externalId}` : epic.externalId
  const lines = [`Epic: ${epic.provider} ${ref} — "${epic.title}" — ${epic.url}`]
  const body = clip(epic.body, EPIC_BODY_LIMIT)
  if (body) lines.push(`  ${body}`)
  return lines
}

/** One linked item as the agent should address it: the id its read tool takes,
 *  the human title, and the live status when the link carries one. */
export function formatTaskLink(link: TaskLink): string {
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
      return `automation ${link.targetKey} — "${title}"${status} (read_automation)`
  }
}
