import { sessionExecutionStatus, type SessionExecution } from '@solus/contracts/session-execution'
import type { AttentionState } from '../../../lib/sessionUtils'

/** Attention for a session with no open tab. */
export function executionAttention(execution: SessionExecution | undefined): AttentionState {
  if (!execution) return null
  const status = sessionExecutionStatus(execution)
  if (status === 'awaiting_input') return execution.awaitingApproval ? 'approval' : 'awaiting'
  if (status === 'awaiting_plan') return 'awaiting_plan'
  if (execution.hasPendingQuestion) return 'awaiting'
  if (status === 'rate_limited') return 'limited'
  if (status === 'failed' || status === 'dead') return 'error'
  if (status === 'connecting') return 'starting'
  if (status === 'running') return 'running'
  if (status === 'background') return 'background'
  return null
}
