import { z } from 'zod'
import type { SessionStatus } from './types'

export const sessionExecutionPhaseSchema = z.enum([
  'connecting', 'running', 'background', 'awaiting_input', 'awaiting_plan', 'rate_limited',
])
export type SessionExecutionPhase = z.infer<typeof sessionExecutionPhaseSchema>

export const sessionTurnOutcomeSchema = z.enum(['completed', 'failed', 'interrupted', 'dead'])
export type SessionTurnOutcome = z.infer<typeof sessionTurnOutcomeSchema>

export const sessionExecutionSchema = z.strictObject({
  revision: z.number().int().positive(),
  current: z.strictObject({
    runId: z.string(),
    phase: sessionExecutionPhaseSchema,
    startedAt: z.number(),
    waitingForAgents: z.literal(true).optional(),
    rateLimitResetsAt: z.number().optional(),
  }).nullable(),
  lastTurn: z.strictObject({
    runId: z.string(),
    outcome: sessionTurnOutcomeSchema,
    startedAt: z.number(),
    endedAt: z.number(),
  }).nullable(),
  hasPendingQuestion: z.literal(true).optional(),
  awaitingApproval: z.literal(true).optional(),
  /** A session this one started, at any depth, waits on the person for this.
   *  Its card in this session's conversation shows the request, so the row
   *  of this session says so too. Absent when none waits. */
  delegatedRequest: z.enum(['question', 'permission', 'plan']).optional(),
})
export type SessionExecution = z.infer<typeof sessionExecutionSchema>
export type DelegatedRequest = NonNullable<SessionExecution['delegatedRequest']>

/** The state shown when no other presentation facts are needed. */
export function sessionExecutionStatus(execution: SessionExecution): SessionStatus {
  return execution.current?.phase ?? execution.lastTurn?.outcome ?? 'idle'
}
