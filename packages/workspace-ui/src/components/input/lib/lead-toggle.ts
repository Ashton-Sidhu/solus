import type { LeadModelSelection } from '@solus/contracts/settings'
import type { RunConfig } from '@solus/contracts/types'
import { runOnModel } from '../../../contexts/workspace/run-config'

/**
 * The run a session starts on when the person turns Lead on: the lead model
 * from Settings → General when one is set, else the run as it is. Turning
 * Lead off changes nothing: the person may already have chosen a model.
 */
export function runForLead(run: RunConfig, leadModel: LeadModelSelection | null): RunConfig {
  return leadModel ? runOnModel(run, leadModel) : run
}

/** The toggle is offered while the session has not started: a draft, or a
 *  tab with no message and no provider conversation. */
export function canChooseLead(session: { messages: unknown[]; agentSessionId: string | null } | undefined, draft: object | undefined): boolean {
  if (draft) return true
  return !!session && session.messages.length === 0 && !session.agentSessionId
}
