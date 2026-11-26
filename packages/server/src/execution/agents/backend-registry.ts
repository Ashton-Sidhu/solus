import { ClaudeBackend } from './claude/claude-backend'
import { CodexBackend } from './codex/codex-backend'
import { createReplayBackend } from './replay/replay-gate'
import { AcpBackend } from './acp/acp-backend'
import { antigravityAgent } from './acp/antigravity'
import { join } from 'node:path'
import { solusDir } from '../../platform/paths'
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
    // Solus tools reach an ACP agent through the host's `/mcp` endpoint, which is
    // not on this branch yet (docs/plans/antigravity-provider.md decision 6).
    ['antigravity', new AcpBackend({ agent: antigravityAgent, historyDirectory: join(solusDir(), 'acp-history') })],
  ])
  const replay = createReplayBackend()
  if (replay) backends.set('replay', replay)
  return backends
}
