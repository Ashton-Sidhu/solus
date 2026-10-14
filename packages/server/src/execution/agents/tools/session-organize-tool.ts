import { z } from 'zod'
import { ANY_ORGANIZATION } from '../../../admission/principal'
import { markSessionUnread, readSessionShelf, settleSession, snoozeSession, unsettleSession } from '../../../data/sessions/session-states'
import type { AgentTool, AgentToolResult } from './agent-tool'
import { findSession } from './session-tools'

/**
 * `organize_session`: an agent moves a session in the person's list, as the
 * person does from the sidebar (docs/plans/session-pull-requests.md). It
 * settles, snoozes, or marks a session unread; each action has its reverse.
 */

const ACTIONS = ['settle', 'unsettle', 'snooze', 'unsnooze', 'mark_unread'] as const

const DESCRIPTION =
  "Organize a session in the user's session list. Omit session_id for this session. settle moves a finished session out of the active list; unsettle makes it active again. snooze hides an active session until snoozed_until; unsnooze wakes it now. mark_unread shows the session as unread. A new prompt to a session makes it active and awake again. Do not settle or snooze a session that still has work the user expects."

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
  const [shelved] = await readSessionShelf(ANY_ORGANIZATION, [sessionId], now)
  const isSettled = shelved?.settledAt != null
  const label = sessionId === callerSessionId ? 'This session' : `Session ${sessionId}`

  switch (input.action) {
    case 'settle':
      return { ok: true, text: await settleSession(sessionId, 'person', now) ? `${label} is settled.` : `${label} was settled already.` }
    case 'unsettle':
      return { ok: true, text: await unsettleSession(sessionId, now) ? `${label} is active again.` : `${label} was not settled.` }
    case 'snooze':
      if (isSettled) return { ok: false, text: `${label} is settled. Unsettle it before you snooze it.` }
      return snooze(sessionId, label, input, now)
    case 'unsnooze':
      if (shelved?.snoozedUntil == null) return { ok: true, text: `${label} was not snoozed.` }
      await snoozeSession(sessionId, null)
      return { ok: true, text: `${label} is awake.` }
    case 'mark_unread':
      await markSessionUnread(sessionId)
      return { ok: true, text: `${label} is marked unread.` }
  }
}

/** A wake time in the past is a snooze that already ended, so it is refused. */
async function snooze(sessionId: string, label: string, input: OrganizeInput, now: number): Promise<AgentToolResult> {
  if (!input.snoozed_until) return { ok: false, text: 'snooze needs snoozed_until.' }
  const until = Date.parse(input.snoozed_until)
  if (until <= now) return { ok: false, text: 'snoozed_until must be in the future.' }
  await snoozeSession(sessionId, until, input.note)
  return { ok: true, text: `${label} is snoozed until ${new Date(until).toISOString()}.` }
}

export const organizeSessionAgentTool: AgentTool<typeof fields> = {
  name: 'organize_session',
  description: DESCRIPTION,
  inputFields: fields,
  requiresApproval: false,
  execute: async (args, context) => organizeSession(inputSchema.parse(args), context.sessionId()),
}
