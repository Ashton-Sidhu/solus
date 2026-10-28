import type { SessionArtifact } from '@solus/contracts/session-artifacts'
import type { AgentConversationRef } from '@solus/contracts/types'
import { sessionArtifactItems } from '@solus/client-core/session-artifact-chips'
import { sessionArtifactsStore } from '../../../../contexts/sessions/session-artifacts.store.svelte'

/** The session whose conversation shows the card, and the host that runs it. */
export interface CardCaller {
  sessionId: string | undefined
  /** Absent until the caller's run names its host. */
  serverId: string | undefined
}

const NONE: readonly SessionArtifact[] = []

/**
 * Where a card reads what its session linked. The caller's list holds a group
 * for each session the caller started, so one read serves every card in its
 * conversation. A session on another host, or one the caller did not start,
 * is read on its own.
 */
function readsOwnList(ref: AgentConversationRef, caller: CardCaller): boolean {
  if (ref.serverId || !caller.sessionId) return true
  const fromCaller = sessionArtifactItems(sessionArtifactsStore.artifactsFor(caller.sessionId), caller.sessionId, ref.sessionId)
  return fromCaller === null && sessionArtifactsStore.isLoaded(caller.sessionId)
}

/** Ask the store for the lists the card reads. Call from an effect. */
export function ensureLinkedArtifacts(ref: AgentConversationRef, caller: CardCaller): void {
  if (caller.sessionId && caller.serverId && !ref.serverId) sessionArtifactsStore.ensure(caller.serverId, caller.sessionId)
  const ownServerId = ref.serverId ?? caller.serverId
  if (ownServerId && readsOwnList(ref, caller)) sessionArtifactsStore.ensure(ownServerId, ref.sessionId)
}

/** What the card's session linked, newest first. Empty until a list answers. */
export function linkedArtifacts(ref: AgentConversationRef, caller: CardCaller): readonly SessionArtifact[] {
  const fromCaller = caller.sessionId && !ref.serverId
    ? sessionArtifactItems(sessionArtifactsStore.artifactsFor(caller.sessionId), caller.sessionId, ref.sessionId)
    : null
  return fromCaller
    ?? sessionArtifactItems(sessionArtifactsStore.artifactsFor(ref.sessionId), ref.sessionId, ref.sessionId)
    ?? NONE
}
