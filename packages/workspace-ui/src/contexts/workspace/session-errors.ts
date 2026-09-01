import type { AgentId } from '@solus/contracts/types'

export class SessionUnavailableError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} is no longer available`)
    this.name = 'SessionUnavailableError'
  }
}

export function unavailableSessionMessage(provider?: AgentId): string {
  return provider === 'claude-code'
    ? 'Claude removes session history after 30 days. The saved plan is still available.'
    : 'The source session no longer exists on this host. The saved plan is still available.'
}
