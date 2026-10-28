import type { LeadModelSelection } from '@solus/contracts/settings'
import type { ConversationRun } from './ipc-context'
import { leadModelRun, type LeadModelRun, type RunDefaults } from './run-settings'

/**
 * The lead choice of a new session's draft (docs/plans/lead-session.md): a
 * lead coordinates workers and does not implement. The conversation sends
 * `isLead` with the prompt that starts the session only; after that the choice
 * is fixed.
 */
export class LeadSessionChoice {
  /** The run a lead model replaced, given back when the lead is turned off. */
  private replaced: LeadModelRun | null = null

  /**
   * Turns the lead on or off on the draft's run. A lead starts on the
   * person's lead model when one is set, as the desktop's `runOnModel`. False
   * when nothing changed, or a prompt already started the session.
   */
  choose(run: ConversationRun, lead: boolean, leadModel: LeadModelSelection | null, defaults: RunDefaults | null): boolean {
    if (run.agentSessionId || (run.lead === true) === lead) return false
    const { provider, preferredModel, reasoningEffort, contextWindow, fastMode } = run
    run.lead = lead
    if (lead && leadModel) {
      this.replaced = { provider, preferredModel, reasoningEffort, contextWindow, fastMode }
      Object.assign(run, leadModelRun(leadModel, defaults))
    } else if (!lead && this.replaced) {
      Object.assign(run, this.replaced)
      this.replaced = null
    }
    return true
  }
}
