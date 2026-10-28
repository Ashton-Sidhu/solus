import { MockAgentBackend } from './mock-backend'
import { createReplayBackend } from '@solus/server/execution/agents/replay/replay-gate'
import type { AgentBackend } from '@solus/server/execution/agents/agent-backend'
import type { AgentId } from '@solus/contracts/types'

/**
 * Test-build replacement for src/main/agents/backend-registry.ts. Aliased in
 * electron.vite.config.ts when BUILD_TARGET=test. claude-code is the
 * deterministic mock the e2e suite drives; the development replay provider
 * joins it where its gate allows, so run-app and the Lab can watch a turn render.
 */
export function createBackends(): Map<AgentId, AgentBackend> {
  const backends = new Map<AgentId, AgentBackend>([['claude-code', new MockAgentBackend()]])
  const replay = createReplayBackend()
  if (replay) backends.set('replay', replay)
  return backends
}
