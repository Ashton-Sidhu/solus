import { z } from 'zod'
import type { SessionStatus } from './types'
import { agentActivityCardSchema, apnsEnvironmentSchema, liveActivityPushTokenSchema, type AgentActivityRow } from './uplink'

/** What a row says about its session. */
export type AgentActivityRowStatus = Pick<AgentActivityRow, 'phase' | 'status'>

/**
 * How a session's live status shows on the iOS Live Activity card. The phone and
 * the host read it from here, so a row a host reports while the app is suspended
 * says what the app would have said (docs/plans/live-activity-push.md).
 */
export function agentActivityRowStatus(status: SessionStatus): AgentActivityRowStatus {
  switch (status) {
    case 'awaiting_plan':
      return { phase: 'waiting_for_approval', status: 'Approval' }
    case 'awaiting_input':
      return { phase: 'waiting_for_input', status: 'Input' }
    case 'connecting':
    case 'running':
      return { phase: 'running', status: 'Working' }
    // Settled turn, background work still running.
    case 'background':
      return { phase: 'running', status: 'Background' }
    case 'rate_limited':
      return { phase: 'limited', status: 'Rate limited' }
    case 'failed':
    case 'dead':
      return { phase: 'failed', status: 'Failed' }
    case 'idle':
    case 'completed':
    case 'interrupted':
      return { phase: 'completed', status: 'Done' }
  }
}

/**
 * `liveActivityRegister`: the phone's card, its push token and the phone's id for
 * this host, so the host knows which rows are its own.
 */
export const liveActivityRegistrationSchema = z.object({
  pushToken: liveActivityPushTokenSchema,
  environment: apnsEnvironmentSchema,
  generation: z.number().int().nonnegative(),
  card: agentActivityCardSchema,
  hostId: z.string().min(1).max(200),
})
export type LiveActivityRegistration = z.infer<typeof liveActivityRegistrationSchema>
