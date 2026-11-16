import { isChat } from '@solus/contracts/chat'
import { DEFAULT_EXECUTION_PREFERENCES } from '@solus/contracts/settings'
import { formatLeadContract } from '../../../data/sessions/lead-contract'
import { isLeadSession, markSessionLead } from '../../../data/sessions/lead-sessions'
import { sessionSettings } from '../../sessions/session-settings'
import type { AgentTool, AgentToolResult } from './agent-tool'
import { getSessionController } from './session-tools'

/**
 * `become_lead`: the agent makes its own session a lead when the work divides
 * into independent parts (docs/plans/lead-session.md). The mark is the same
 * one the composer's Meta mode button asks for, and as permanent. The result
 * carries the lead contract for the turn in progress, whose system prompt
 * cannot change; the run launcher adds it to every later run.
 */

const DESCRIPTION =
  'Make this session a lead. A lead coordinates: it starts a session for each part of the work with start_sessions and does not do the parts itself. The change is permanent for this session. The result gives the lead contract; follow it from then on. Refused for a session that another session started as its child, and for a chat.'

export async function becomeLead(sessionId: string | undefined, cwd: string): Promise<AgentToolResult> {
  if (!sessionId) return { ok: false, text: 'become_lead is unavailable before this session is initialized.' }
  const preferences = sessionSettings(sessionId)?.preferences
  const contract = formatLeadContract({
    leadInstructions: preferences?.leadInstructions ?? DEFAULT_EXECUTION_PREFERENCES.leadInstructions,
    workerModel: preferences?.workerModel ?? DEFAULT_EXECUTION_PREFERENCES.workerModel,
  })
  if (await isLeadSession(sessionId)) return { ok: true, text: `This session is a lead already.\n\n${contract}` }
  // A chat has no project to divide (docs/plans/projectless-chat.md), and a
  // worker that became a lead would start a tree of sessions nobody asked for.
  if (isChat(cwd)) return { ok: false, text: 'A chat cannot become a lead. Do the work in this session.' }
  const info = await getSessionController()?.getSessionInfo(sessionId)
  if (info?.delegation?.intent === 'delegate') {
    return { ok: false, text: 'A session that another session started as its child cannot become a lead. Do the work in this session.' }
  }
  await markSessionLead(sessionId, sessionSettings(sessionId)?.organizationId, 'agent')
  return { ok: true, text: `This session is now a lead.\n\n${contract}` }
}

export const becomeLeadAgentTool: AgentTool = {
  name: 'become_lead',
  description: DESCRIPTION,
  inputFields: {} as const,
  requiresApproval: false,
  // The orchestration instructions say when to call it; the agent must not
  // need a tool search between that decision and the call.
  alwaysLoad: true,
  execute: async (_input, context) => becomeLead(context.sessionId(), context.cwd),
}
