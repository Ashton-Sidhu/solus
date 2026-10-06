import type { AgentId } from '@solus/contracts/types'
import { threadKey } from './thread-directory'

/**
 * Sessions started from the new-task sheet that the host has not listed yet.
 * The thread route opens one by its id alone; this is where the new session's
 * agent and folder wait until the session directory knows the session.
 */
export interface NewThreadTarget {
  readonly sessionId: string
  readonly provider: AgentId
  readonly workingDirectory: string
}

const targets = new Map<string, NewThreadTarget>()

export function rememberNewThreadTarget(hostId: string, target: NewThreadTarget): void {
  targets.set(threadKey(hostId, target.sessionId), target)
}

export function newThreadTarget(hostId: string, sessionId: string): NewThreadTarget | null {
  return targets.get(threadKey(hostId, sessionId)) ?? null
}
