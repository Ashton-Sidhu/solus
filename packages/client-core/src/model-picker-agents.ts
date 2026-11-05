import type { AgentId } from '@solus/contracts/types'

/** A development host must not expose Replay in a production client's picker. */
export function isModelPickerAgentVisible(provider: AgentId, isDevelopment: boolean): boolean {
  return provider !== 'replay' || isDevelopment
}
