import { AGENT_BIN } from '@solus/contracts/types'
import { findOnPath, getCliPath } from '../../cli-env'
import { createLogger } from '../../logger'
import { providerLoginConnected } from '../seats/seat-login'
import { isSeatProvider, type TurnSeat } from '../seats/seat-manager'
import type { AgentBackend } from './agent-backend'

const log = createLogger('main', 'reported-models.ts')

/**
 * Asks an agent that reports its models only when a session opens (Google
 * Antigravity, docs/plans/antigravity-provider.md §5.5) for them again: at
 * boot, after a sign-in, and when a person refreshes the model list. A new plan
 * on the account then shows without a session. It never starts a sign-in: with
 * no `seat`, it runs only when the agent is installed and the host's login is
 * signed in. Quiet on failure: the last list stays.
 */
export async function refreshReportedModels(backend: AgentBackend, seat?: TurnSeat): Promise<void> {
  if (!backend.refreshModels) return
  if (!seat) {
    const bin = AGENT_BIN[backend.id]
    if (!bin || !findOnPath(bin, getCliPath())) return
    if (!isSeatProvider(backend.id) || !await providerLoginConnected(backend.id, null)) return
  }
  try {
    await backend.refreshModels(seat)
  } catch (error) {
    log.warn('agent_models_refresh_failed', { provider: backend.id, error: error instanceof Error ? error.message : String(error) })
  }
}
