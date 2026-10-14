import { z } from 'zod'
import { markSessionUnread, SessionShelf } from '../../../data/sessions/session-states'
import type { AgentTool, AgentToolResult } from './agent-tool'
import { findSession } from './session-tools'

/**
 * `organize_session`: an agent moves a session in the person's list, as the
 * person does from the sidebar (docs/plans/session-pull-requests.md,
 * docs/plans/session-archive.md). It settles, snoozes, archives, or marks a
 * session unread; each action has its reverse.
 */

const ACTIONS = ['settle', 'unsettle', 'snooze', 'unsnooze', 'archive', 'unarchive', 'mark_unread'] as const

const DESCRIPTION =
  "Organize a session in the user's session list. Omit session_id for this session. settle moves a finished session out of the active list; unsettle makes it active again. snooze hides an active session until snoozed_until; unsnooze wakes it now. archive removes a session from the list on every device; the session picker still finds it, and unarchive returns it to the list. mark_unread shows the session as unread. A new prompt to a session makes it active, awake, and in the list again. Do not settle, snooze, or archive a session that still has work the user expects."

const fields = {
  action: z.enum(ACTIONS),
  session_id: z.string().optional().describe('The session to organize. Defaults to this session.'),
  snoozed_until: z.iso.datetime({ offset: true }).optional().describe('ISO 8601 wake time, for snooze. Must be in the future.'),
  note: z.string().optional().describe('Why the session is snoozed, shown to the user. For snooze only.'),
}
const inputSchema = z.object(fields)
type OrganizeInput = z.output<typeof inputSchema>

export async function organizeSession(input: OrganizeInput, callerSessionId: string | undefined, now = Date.now()): Promise<AgentToolResult> {
  const named = input.session_id?.trim()
  const sessionId = named && named !== callerSessionId ? (await findSession(named))?.sessionId : callerSessionId
  if (!sessionId) {
    return { ok: false, text: named ? `Session ${named} not found.` : 'organize_session needs a session_id: this session has no id yet.' }
  }
  const shelf = new SessionShelf(sessionId)
  const state = await shelf.state()
  const label = sessionId === callerSessionId ? 'This session' : `Session ${sessionId}`

  switch (input.action) {
    case 'settle':
      return { ok: true, text: await shelf.settle('person', now) ? `${label} is settled.` : `${label} was settled already.` }
    case 'unsettle':
      return { ok: true, text: await shelf.unsettle(now) ? `${label} is active again.` : `${label} was not settled.` }
    case 'snooze':
      if (state.settledAt !== null) return { ok: false, text: `${label} is settled. Unsettle it before you snooze it.` }
      return snooze(shelf, label, input, now)
    case 'unsnooze':
      if (state.snoozedUntil === null) return { ok: true, text: `${label} was not snoozed.` }
      await shelf.snooze(null)
      return { ok: true, text: `${label} is awake.` }
    case 'archive':
    case 'unarchive':
      return setArchived(shelf, label, input.action === 'archive', now)
    case 'mark_unread':
      await markSessionUnread(sessionId)
      return { ok: true, text: `${label} is marked unread.` }
  }
}

/** Archive the session, or return it to the list. Either is a no-op when it is there already. */
async function setArchived(shelf: SessionShelf, label: string, isArchived: boolean, now: number): Promise<AgentToolResult> {
  if (isArchived) return { ok: true, text: await shelf.archive(now) ? `${label} is archived.` : `${label} was archived already.` }
  return { ok: true, text: await shelf.unarchive() ? `${label} is back in the list.` : `${label} was not archived.` }
}

/** A wake time in the past is a snooze that already ended, so it is refused. */
async function snooze(shelf: SessionShelf, label: string, input: OrganizeInput, now: number): Promise<AgentToolResult> {
  if (!input.snoozed_until) return { ok: false, text: 'snooze needs snoozed_until.' }
  const until = Date.parse(input.snoozed_until)
  if (until <= now) return { ok: false, text: 'snoozed_until must be in the future.' }
  await shelf.snooze(until, input.note)
  return { ok: true, text: `${label} is snoozed until ${new Date(until).toISOString()}.` }
}

export const organizeSessionAgentTool: AgentTool<typeof fields> = {
  name: 'organize_session',
  description: DESCRIPTION,
  inputFields: fields,
  requiresApproval: false,
  execute: async (args, context) => organizeSession(inputSchema.parse(args), context.sessionId()),
}
