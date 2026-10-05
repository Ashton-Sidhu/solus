import type { Actor } from '../../admission/actor'
import type { RestartRun } from '../../data/sessions/session-restart-store'
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

export function restartContinuationPrompt(saved: RestartRun): string {
  const background = saved.backgroundTools.length
    ? `\nThe host lost tracking for these active tools or child agents: ${saved.backgroundTools.map((tool) => tool.name).join(', ')}. Check whether detached processes are still running before restarting them.` : ''
  const source = saved.input.agentSessionId ? '' : `\nPrevious task: ${saved.prompt}`
  return `The Solus host restarted. Continue where you left off. Inspect the workspace and history before repeating actions; the last run may have made changes.${background}${source}`
}
