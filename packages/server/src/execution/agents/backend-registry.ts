import { ClaudeBackend } from './claude/claude-backend'
import { CodexBackend } from './codex/codex-backend'
import { createReplayBackend } from './replay/replay-gate'
import type { AgentBackend } from './agent-backend'
import type { AgentId } from '@solus/contracts/types'

/**
 * Production agent backends. The e2e test build aliases this module to
 * tests/e2e/mock/backend-registry.ts (see electron.vite.config.ts), so no test
 * doubles are ever bundled into release builds.
 */
export function createBackends(): Map<AgentId, AgentBackend> {
  const backends = new Map<AgentId, AgentBackend>([
    ['claude-code', new ClaudeBackend()],
    ['codex', new CodexBackend()],
  ])
  const replay = createReplayBackend()
  if (replay) backends.set('replay', replay)
  return backends
}
