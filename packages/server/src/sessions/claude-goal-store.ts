import type { DatabaseSync } from 'node:sqlite'
import { getDb } from '../db'
import { isSessionBusyStatus } from '@solus/contracts/types'
import type { SessionStatus, ThreadGoal, ThreadGoalSetRequest, UsageData } from '@solus/contracts/types'
import { z } from 'zod'

const KEY_PREFIX = 'claude-thread-goal:'
const goalRowSchema = z.object({ value: z.string() })
const threadGoalSchema = z.object({
  threadId: z.string(),
  objective: z.string(),
  status: z.enum(['active', 'paused', 'complete', 'blocked']),
  tokenBudget: z.number().optional(),
  tokensUsed: z.number().optional(),
  timeUsedSeconds: z.number().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
})

function goalKey(threadId: string): string {
  return `${KEY_PREFIX}${threadId}`
}

function turnTokens(usage: UsageData): number {
  return (usage.inputTokens ?? 0)
    + (usage.outputTokens ?? 0)
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheCreationTokens ?? 0)
}

/** Solus-owned persistence for the subset of goals Claude supports. Claude can
 * create and read a goal; mutation controls remain backed by Codex only. */
export class ClaudeGoalStore {
  constructor(
    private readonly database: () => DatabaseSync = getDb,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(threadId: string): ThreadGoal | null {
    const parsedRow = goalRowSchema.safeParse(this.database()
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(goalKey(threadId)))
    if (!parsedRow.success) return null

    try {
      const parsedGoal = threadGoalSchema.safeParse(JSON.parse(parsedRow.data.value))
      return parsedGoal.success && parsedGoal.data.threadId === threadId ? parsedGoal.data : null
    } catch {
      return null
    }
  }

  create(request: ThreadGoalSetRequest): ThreadGoal {
    const objective = request.objective?.trim()
    if (!objective || objective.length > 4000) {
      throw new Error('Goal objectives must be between 1 and 4,000 characters')
    }
    if (this.get(request.threadId)) {
      throw new Error('Claude goals cannot be updated after creation')
    }

    const now = this.now()
    const goal: ThreadGoal = {
      threadId: request.threadId,
      objective,
      status: 'active',
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: now,
      updatedAt: now,
    }
    if (request.tokenBudget !== undefined) goal.tokenBudget = request.tokenBudget
    this.write(goal)
    return goal
  }

  recordCompletedTurn(threadId: string, usage: UsageData, durationMs: number): ThreadGoal | null {
    const goal = this.get(threadId)
    if (!goal) return null

    goal.tokensUsed = (goal.tokensUsed ?? 0) + turnTokens(usage)
    goal.timeUsedSeconds = (goal.timeUsedSeconds ?? 0) + Math.max(0, durationMs) / 1000
    goal.updatedAt = this.now()
    this.write(goal)
    return goal
  }

  applySessionStatus(threadId: string, status: SessionStatus): ThreadGoal | null {
    const goal = this.get(threadId)
    if (!goal) return null
    const goalStatus = status === 'completed'
      ? 'complete'
      : status === 'interrupted'
        ? 'paused'
        : isSessionBusyStatus(status)
          ? 'active'
          : goal.status
    if (goal.status === goalStatus) return null

    goal.status = goalStatus
    goal.updatedAt = this.now()
    this.write(goal)
    return goal
  }

  private write(goal: ThreadGoal): void {
    this.database()
      .prepare(`
        INSERT INTO kv (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run(goalKey(goal.threadId), JSON.stringify(goal))
  }
}
