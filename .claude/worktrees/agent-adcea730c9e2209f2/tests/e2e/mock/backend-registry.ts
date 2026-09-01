import { MockAgentBackend } from './mock-backend'
import type { AgentBackend } from '../../../src/main/agents/agent-backend'
import type { AgentId } from '../../../src/shared/types'

/**
 * Test-build replacement for src/main/agents/backend-registry.ts. Aliased in
 * electron.vite.config.ts when BUILD_TARGET=test. Only claude-code is wired —
 * the e2e suite exercises a single deterministic backend.
 */
export function createBackends(): Map<AgentId, AgentBackend> {
  return new Map<AgentId, AgentBackend>([['claude-code', new MockAgentBackend()]])
}
