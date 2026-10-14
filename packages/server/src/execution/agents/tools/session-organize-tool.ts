import { z } from 'zod'
import { markSessionUnread } from '../../../data/sessions/session-states'
import { workspaceToolContext } from '../../../data/workspace/tool-context'
import type { WorkspaceOperations } from '../../../data/workspace/operations'
import type { WorkspaceRequestContext } from '../../../admission/workspace-credentials'
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
  "Organize a session in the user's session list. Omit session_id for this session. settle moves a finished session out of the active list; unsettle makes it active again. snooze hides an active session until snoozed_until; unsnooze wakes it now. archive removes a session from the user's own list on every device; the session picker still finds it, and unarchive returns it to the list. Snooze and archive change only the user's own list; settle is shared. mark_unread shows the session as unread. A new prompt to a session makes it active, awake, and in the list again. Do not settle, snooze, or archive a session that still has work the user expects."

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
  const label = sessionId === callerSessionId ? 'This session' : `Session ${sessionId}`
  if (input.action === 'mark_unread') {
    await markSessionUnread(sessionId)
    return { ok: true, text: `${label} is marked unread.` }
  }
  // The session's home keeps where it is in the list: its organization's Solus
  // API, or this machine (docs/plans/session-archive.md).
  const { operations, context } = await workspaceToolContext(sessionId)
  const home = new SessionHome(operations, context, sessionId, label)
  switch (input.action) {
    case 'settle': return home.setSettled(true)
    case 'unsettle': return home.setSettled(false)
    case 'snooze': return home.snooze(input, now)
    case 'unsnooze': return home.wake()
    case 'archive': return home.setArchived(true)
    case 'unarchive': return home.setArchived(false)
  }
}

/** One session, organized at its home as the person the run is for. */
class SessionHome {
  constructor(
    private readonly operations: WorkspaceOperations,
    private readonly context: WorkspaceRequestContext,
    private readonly sessionId: string,
    private readonly label: string,
  ) {}

  async setSettled(isSettled: boolean): Promise<AgentToolResult> {
    const before = (await this.operations.getSession(this.context, this.sessionId)).state?.settledAt != null
    if (before === isSettled) return { ok: true, text: isSettled ? `${this.label} was settled already.` : `${this.label} was not settled.` }
    await this.operations.updateSession(this.context, this.sessionId, { settled: isSettled })
    return { ok: true, text: isSettled ? `${this.label} is settled.` : `${this.label} is active again.` }
  }

  /** A wake time in the past is a snooze that already ended, and a settled
   *  session is not snoozed, so both are refused. */
  async snooze(input: OrganizeInput, now: number): Promise<AgentToolResult> {
    if (!input.snoozed_until) return { ok: false, text: 'snooze needs snoozed_until.' }
    const until = Date.parse(input.snoozed_until)
    if (until <= now) return { ok: false, text: 'snoozed_until must be in the future.' }
    if ((await this.operations.getSession(this.context, this.sessionId)).state?.settledAt != null) {
      return { ok: false, text: `${this.label} is settled. Unsettle it before you snooze it.` }
    }
    await this.operations.updateSession(this.context, this.sessionId, { snoozedUntil: until, snoozeNote: input.note })
    return { ok: true, text: `${this.label} is snoozed until ${new Date(until).toISOString()}.` }
  }

  async wake(): Promise<AgentToolResult> {
    if ((await this.operations.getSession(this.context, this.sessionId)).view?.snoozedUntil == null) return { ok: true, text: `${this.label} was not snoozed.` }
    await this.operations.updateSession(this.context, this.sessionId, { snoozedUntil: null })
    return { ok: true, text: `${this.label} is awake.` }
  }

  /** Archive the session for the person, or return it to their list. */
  async setArchived(isArchived: boolean): Promise<AgentToolResult> {
    const before = (await this.operations.getSession(this.context, this.sessionId)).view?.archivedAt != null
    if (before === isArchived) return { ok: true, text: isArchived ? `${this.label} was archived already.` : `${this.label} was not archived.` }
    await this.operations.updateSession(this.context, this.sessionId, { archived: isArchived })
    return { ok: true, text: isArchived ? `${this.label} is archived.` : `${this.label} is back in the list.` }
  }
}

export const organizeSessionAgentTool: AgentTool<typeof fields> = {
  name: 'organize_session',
  description: DESCRIPTION,
  inputFields: fields,
  requiresApproval: false,
  execute: async (args, context) => organizeSession(inputSchema.parse(args), context.sessionId()),
}
