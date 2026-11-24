import type { AgentId } from './types'

export type ProviderStartupPhase = 'starting' | 'resuming' | 'mcp' | 'connecting' | 'waiting'

export interface ProviderStartup {
  provider: AgentId
  phase: ProviderStartupPhase
}
