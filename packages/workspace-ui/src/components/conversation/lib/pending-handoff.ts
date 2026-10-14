import type { AgentId, Session } from '@solus/contracts/types'

/**
 * The provider a session's composer picked away from its thread's provider, or
 * null (plans/021). A pick is composer state: the host hands the thread over
 * only when a prompt carries the picked provider, so until then the transcript
 * says a handoff is pending. A pick back closes it; a session with no thread
 * has nothing to hand over.
 */
export function pendingHandoffProvider(session: Pick<Session, 'run' | 'threadProvider'>): AgentId | null {
  const picked = session.run.provider
  const thread = session.threadProvider
  return picked && thread && picked !== thread ? picked : null
}
