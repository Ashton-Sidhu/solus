import { z } from 'zod'
import { getDb } from '../../db'
import { userSchema } from '@solus/contracts/user'
import { savedRunInputSchema } from './session-queue-store'

export const restartRunSchema = z.object({
  sessionId: z.string(), runId: z.string(), input: savedRunInputSchema,
  state: z.enum(['starting', 'running', 'background', 'delivering']),
  author: userSchema.nullable(),
  authority: z.enum(['owner', 'host']),
  taskId: z.string().optional(),
  queueId: z.string().optional(),
  clientPromptId: z.string().optional(),
  prompt: z.string(),
  backgroundTools: z.array(z.object({ toolId: z.string(), name: z.string() })).max(32),
})
export type RestartRun = z.infer<typeof restartRunSchema>

/** Host-local receipts, never credentials or provider callback state. Each
 * session retains only its current run. Delivery is claimed before queueing.
 * One runtime owns this store. Its snapshot avoids SQL reads on live events;
 * changed receipts are still written synchronously before work proceeds. */
export class SessionRestartStore {
  private runs: Map<string, { run: RestartRun; payload: string }> | undefined

  private snapshot(): Map<string, { run: RestartRun; payload: string }> {
    if (this.runs) return this.runs
    const rows = getDb().prepare('SELECT payload FROM session_restart_runs ORDER BY updated_at, session_id').all()
    const runs = new Map<string, { run: RestartRun; payload: string }>()
    for (const row of rows) {
      const payload = z.object({ payload: z.string() }).parse(row).payload
      const run = restartRunSchema.parse(JSON.parse(payload))
      runs.set(run.sessionId, { run, payload: JSON.stringify(run) })
    }
    this.runs = runs
    return runs
  }

  list(): RestartRun[] {
    return Array.from(this.snapshot().values(), ({ run }) => structuredClone(run))
  }

  get(sessionId: string): RestartRun | undefined {
    const saved = this.snapshot().get(sessionId)
    return saved ? structuredClone(saved.run) : undefined
  }

  save(run: RestartRun): void {
    const parsed = restartRunSchema.parse(run)
    const payload = JSON.stringify(parsed)
    const runs = this.snapshot()
    if (runs.get(run.sessionId)?.payload === payload) return
    getDb().prepare(`INSERT INTO session_restart_runs(session_id, run_id, state, payload, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
      run_id = excluded.run_id, state = excluded.state, payload = excluded.payload, updated_at = excluded.updated_at`)
      .run(run.sessionId, run.runId, run.state, payload, Date.now())
    runs.set(run.sessionId, { run: parsed, payload })
  }

  remove(sessionId: string, runId?: string): void {
    const runs = this.snapshot()
    const saved = runs.get(sessionId)
    if (!saved || (runId && saved.run.runId !== runId)) return
    if (runId) getDb().prepare('DELETE FROM session_restart_runs WHERE session_id = ? AND run_id = ?').run(sessionId, runId)
    else getDb().prepare('DELETE FROM session_restart_runs WHERE session_id = ?').run(sessionId)
    runs.delete(sessionId)
  }

  claim(run: RestartRun): boolean {
    const runs = this.snapshot()
    const claimed = restartRunSchema.parse({ ...run, state: 'delivering' })
    const payload = JSON.stringify(claimed)
    const result = getDb().prepare(`UPDATE session_restart_runs SET state = 'delivering', payload = ?, updated_at = ?
      WHERE session_id = ? AND run_id = ? AND state != 'delivering'`)
      .run(payload, Date.now(), run.sessionId, run.runId)
    if (Number(result.changes) !== 1) {
      // Another claimant may have changed the receipt. Refresh on the next read.
      this.runs = undefined
      return false
    }
    runs.set(run.sessionId, { run: claimed, payload })
    return true
  }
}
