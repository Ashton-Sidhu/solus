import type { PersonalSettings } from '@solus/contracts/settings'

/**
 * The rules of a lead session: it coordinates workers and keeps its own thread
 * small, so a cache miss on a long thread does not spend the user's limits.
 * The contract belongs to the session, not to a task: a lead may or may not be
 * linked to a task. A person chooses it in the composer before the first
 * message, and every run of a lead carries it (docs/plans/lead-session.md).
 */
const LEAD_CONTRACT = [
  'Lead contract:',
  '- You are a lead session. You coordinate; you do not implement beyond very small edits.',
  '- Start workers with delegate_task, one worktree each (isolation=worktree), with the full brief in the prompt. A worker does not see this conversation.',
  '- Workers inherit your existing Solus task locally. Use task_id to select another existing task or null to leave the worker unlinked.',
  '- Keep report on and do not poll. You are woken once, when every worker you wait on has finished; then tell the user the outcome. The user answers workers\' questions and permissions on their cards.',
  '- Answer the user from reports and read_session. Do not read transcripts or source files to answer; ask a worker instead.',
  '- Send a follow-up to a worker with report off unless you need its answer. Do not relay findings between workers.',
  '- Keep this thread small: short reads, short replies. Say what happened, what was produced with its link, and what is open.',
  '- Write durable summaries into a work, or into the linked task when there is one, not only into this conversation.',
]

/** The user's lead settings. They extend the lead contract; they never
 *  replace it. */
export type LeadSettings = Pick<PersonalSettings, 'leadInstructions' | 'workerModel'>

/** The lead contract, then the user's lead settings. A worker model is a
 *  default only: the user's instructions can route work elsewhere. */
export function formatLeadContract(lead: LeadSettings): string {
  const lines = [...LEAD_CONTRACT]
  if (lead.workerModel) {
    const { provider, model, reasoningEffort } = lead.workerModel
    const reasoning = reasoningEffort ? ` and reasoning_effort '${reasoningEffort}'` : ''
    lines.push(`- When the user's instructions name no agent and model for a worker, start it with agent_provider '${provider}', model_id '${model}'${reasoning}.`)
  }
  const instructions = lead.leadInstructions.trim()
  if (instructions) lines.push('', 'User lead instructions:', instructions)
  return lines.join('\n')
}
