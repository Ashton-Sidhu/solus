import { MockAgentBackend } from './mock-backend'
import type { AgentBackend } from '@solus/server/agents/agent-backend'
import type { AgentId } from '@solus/contracts/types'

/**
 * Test-build replacement for src/main/agents/backend-registry.ts. Aliased in
 * electron.vite.config.ts when BUILD_TARGET=test. Both provider identities use deterministic normalized scenarios.
 * Real adapter protocols remain covered by their focused unit tests.
 */
export function createBackends(): Map<AgentId, AgentBackend> {
  return new Map<AgentId, AgentBackend>([
    ['claude-code', new MockAgentBackend('claude-code')],
    ['codex', new MockAgentBackend('codex')],
  ])
}
