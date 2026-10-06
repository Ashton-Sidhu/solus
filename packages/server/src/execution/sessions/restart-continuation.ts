import type { Actor } from '../../admission/actor'
import type { RestartRun } from '../../data/sessions/run-ledger'
import type { SessionLineageMember } from '@solus/contracts/types'
import { sameUser, type User } from '@solus/contracts/user'
import { hostCategory } from '../../host/host-category'
import { getHostConfig } from '../../host/settings'

export function restartRecoveryEnabled(): boolean {
  return hostCategory() !== 'managed' && getHostConfig().config.continueSessionsAfterHostRestart
}

export function restartAuthority(actor?: Actor): RestartRun['authority'] | null {
  if (!actor || actor.principal.kind === 'system') return 'host'
  if (actor.principal.kind === 'local-owner' || actor.principal.kind === 'remote-owner') return 'owner'
  return null
}

export function restartContinuationError(saved: RestartRun, owner: User | null,
  lineage?: Pick<SessionLineageMember, 'provider' | 'providerSessionId'>): string | undefined {
  if (saved.state === 'delivering') return 'The host stopped during recovery delivery. Check history before resuming.'
  if (!saved.input.agentSessionId) return 'The host stopped before the provider identified its conversation. Check the workspace before retrying.'
  if (lineage && (lineage.provider !== saved.input.provider || lineage.providerSessionId !== saved.input.agentSessionId)) {
    return 'The session provider changed after this run. Review its history before resuming.'
  }
  if (saved.author && (!owner || !sameUser(owner.id, saved.author.id))) return 'The host owner changed. The original author must review this recovery.'
}

const RESTART_CONTINUATION_PROMPT = 'Continue where you left off'

/** The continuation for a restarted run. The host lost track of the tools and
 *  background work the run had going, so the agent is told which, rather than
 *  waiting for a result that may never come. Names only: tool inputs can hold
 *  private data. */
export function restartContinuationPrompt(saved: Pick<RestartRun, 'backgroundTools'>): string {
  if (saved.backgroundTools.length === 0) return RESTART_CONTINUATION_PROMPT
  const names = [...new Set(saved.backgroundTools.map((tool) => tool.name))].join(', ')
  return `${RESTART_CONTINUATION_PROMPT}. The host restarted while these tools or child agents were running: ${names}. Check whether they still run before you start them again.`
}
