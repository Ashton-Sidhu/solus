import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { PromptOptions, SessionRunInput } from '@solus/contracts/types'
import { queueAttachmentSchema } from '@solus/contracts/session-queue'
import { userSchema } from '@solus/contracts/user'
import { getDb, withTx } from '../../db'

/**
 * The run ledger: the one durable source for the lifecycle of a run on this
 * host. A queue entry is a run that has not started. An exchange is a run that
 * another session started. An active run is the restart receipt of a run that
 * is still going. All three live in the host SQLite file, so one transaction
 * can change them together (docs/plans/orchestration-queue.md).
 *
 * The ledger stores records only. Live promises, tools, timers, provider
 * callbacks, credentials, and permission grants stay in the process. Records
 * are host-local execution state, never mirrored domain data.
 */

const inputFields = z.object({
  provider: z.enum(['claude-code', 'codex', 'opencode']), agentSessionId: z.string().nullable(),
  workingDirectory: z.string(), projectPath: z.string(), model: z.string(), preferredModel: z.string().nullable(),
  forked: z.boolean(), additionalDirs: z.array(z.string()), sessionChangedFiles: z.array(z.string()),
  contextWindow: z.number().nullable(), fastMode: z.boolean(), extraInstructions: z.string(),
  permissionMode: z.enum(['supervised', 'accept-edits', 'auto', 'full-access', 'plan']),
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode']),
  rateLimitBehavior: z.enum(['ask', 'queue', 'continue', 'stop']), worktreeBaseBranch: z.string().nullable(),
})
const optionFields = z.object({
  prompt: z.string(), displayPrompt: z.string().optional(), clientPromptId: z.string().optional(),
  imageAttachments: z.array(z.object({ mimeType: z.string(), dataUrl: z.string() })).optional(),
  imageAttachmentRefs: z.array(z.object({ mimeType: z.string(), hostPath: z.string(), name: z.string().optional() })).optional(),
  queueAttachments: z.array(queueAttachmentSchema).optional(),
})

/** The host wrote these run payloads after admission. Validate the execution
 * fields without stripping task packets or other optional provider context. */
export const savedRunInputSchema = z.custom<SessionRunInput>((value) => inputFields.safeParse(value).success)
const savedOptions = z.custom<PromptOptions>((value) => optionFields.safeParse(value).success)

export const savedQueueEntrySchema = z.object({
  queueId: z.string(), sessionId: z.string(), prompt: z.string(), enqueuedAt: z.number(),
  reason: z.enum(['busy', 'rate_limit']), revision: z.number().int().nonnegative(),
  kind: z.enum(['prompt', 'provider_switch']), held: z.boolean(), error: z.string().optional(),
  input: savedRunInputSchema, requestedInput: savedRunInputSchema.optional(), options: savedOptions, author: userSchema.optional(),
  sourceSessionId: z.string().optional(), rateLimitSessionId: z.string().optional(),
  releaseAt: z.number().optional(), rateLimitType: z.string().optional(), runId: z.string().optional(),
  exchangeIds: z.array(z.string()).optional(),
  reportExchangeIds: z.array(z.string()).optional(),
  started: z.boolean().optional(),
})
export type SavedQueueEntry = z.infer<typeof savedQueueEntrySchema>

export const restartRunSchema = z.object({
  sessionId: z.string(), runId: z.string(), input: savedRunInputSchema,
  state: z.enum(['starting', 'running', 'background', 'awaiting_input', 'delivering']),
  author: userSchema.nullable(),
  authority: z.enum(['owner', 'host']),
  taskId: z.string().optional(),
  queueId: z.string().optional(),
  clientPromptId: z.string().optional(),
  prompt: z.string(),
  backgroundTools: z.array(z.object({ toolId: z.string(), name: z.string() })).max(32),
})
export type RestartRun = z.infer<typeof restartRunSchema>

const deliveryStateSchema = z.enum(['pending', 'queued', 'accepted', 'disposed'])
export type DeliveryState = z.infer<typeof deliveryStateSchema>

const exchangeFields = {
  exchangeId: z.string(), kind: z.enum(['create', 'prompt']),
  senderSessionId: z.string(), targetSessionId: z.string(),
  provider: z.enum(['claude-code', 'codex', 'opencode']), notify: z.boolean(),
  state: z.enum(['dispatched', 'queued', 'running', 'awaiting_input', 'rate_limited', 'waiting_for_children', 'settled']),
  runId: z.string().optional(), parentExchangeIds: z.array(z.string()),
  fingerprint: z.string().optional(), disposition: z.enum(['started', 'steered', 'queued']).optional(),
  dispatchedAt: z.number(), settledAt: z.number().optional(),
  outcome: z.enum(['completed', 'failed', 'interrupted']).optional(),
  outputsText: z.string(),
  /** The bounded report the sender's model reads. */
  reportText: z.string().optional(),
  deliveryState: deliveryStateSchema.optional(),
  deliveryQueueId: z.string().optional(),
}
export const savedExchangeSchema = z.object({
  ...exchangeFields,
  /** The complete reply. The report keeps only its bounded head. */
  reply: z.string().optional(),
})
export type SavedExchange = z.infer<typeof savedExchangeSchema>

/** Closed receipts keep a thirty-day retry window without growing forever. */
const CLOSED_RECEIPT_MS = 30 * 86_400_000

export class RunLedger {
  readonly activeRuns: ActiveRuns
  private readonly reportsQueuedListeners: Array<(exchangeIds: string[], queueId: string) => void> = []

  /** `legacyDirectory` holds the JSON receipts of earlier versions. They move
   *  into the ledger once, and the files are removed. */
  constructor(legacyDirectory?: string) {
    if (legacyDirectory) importLegacyReceipts(legacyDirectory)
    this.activeRuns = new ActiveRuns()
  }

  /** Called after a committed queue write moved reports into a queued prompt. */
  onReportsQueued(listener: (exchangeIds: string[], queueId: string) => void): void {
    this.reportsQueuedListeners.push(listener)
  }

  loadQueue(): SavedQueueEntry[] {
    return getDb().prepare('SELECT payload FROM run_queue ORDER BY session_id, position').all()
      .map((row) => savedQueueEntrySchema.parse(JSON.parse(z.object({ payload: z.string() }).parse(row).payload)))
  }

  /** Replaces one session's queue. A prompt that carries reports takes over
   *  their delivery in the same transaction, so the queue position and the
   *  report delivery state never disagree after a crash. */
  saveQueue(sessionId: string, entries: readonly SavedQueueEntry[]): void {
    const queued: Array<{ exchangeIds: string[]; queueId: string }> = []
    withTx(() => {
      const db = getDb()
      const now = Date.now()
      db.prepare('DELETE FROM run_queue WHERE session_id = ?').run(sessionId)
      entries.forEach((entry, position) => {
        db.prepare('INSERT INTO run_queue(queue_id, session_id, position, payload, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(entry.queueId, sessionId, position, JSON.stringify(entry), now)
        if (entry.started) return
        const exchangeIds = (entry.reportExchangeIds ?? []).filter((exchangeId) => Number(db.prepare(`UPDATE run_exchanges
          SET delivery_state = 'queued', delivery_queue_id = ?, updated_at = ?
          WHERE exchange_id = ? AND delivery_state IN ('pending', 'queued') AND delivery_queue_id IS NOT ?`)
          .run(entry.queueId, now, exchangeId, entry.queueId).changes) > 0)
        if (exchangeIds.length) queued.push({ exchangeIds, queueId: entry.queueId })
      })
    })
    for (const { exchangeIds, queueId } of queued) {
      for (const listener of this.reportsQueuedListeners) listener(exchangeIds, queueId)
    }
  }

  /** Active exchanges and undelivered results stay as long as needed. */
  loadExchanges(now = Date.now()): SavedExchange[] {
    const db = getDb()
    db.prepare(`DELETE FROM run_exchanges WHERE state = 'settled' AND delivery_state IN ('accepted', 'disposed')
      AND COALESCE(settled_at, updated_at) < ?`).run(now - CLOSED_RECEIPT_MS)
    return db.prepare('SELECT payload, delivery_state, delivery_queue_id, report, reply FROM run_exchanges ORDER BY rowid').all().map((row) => {
      const columns = z.object({
        payload: z.string(), delivery_state: z.string().nullable(), delivery_queue_id: z.string().nullable(),
        report: z.string().nullable(), reply: z.string().nullable(),
      }).parse(row)
      return savedExchangeSchema.parse({
        ...JSON.parse(columns.payload),
        deliveryState: columns.delivery_state ?? undefined, deliveryQueueId: columns.delivery_queue_id ?? undefined,
        reportText: columns.report ?? undefined, reply: columns.reply ?? undefined,
      })
    })
  }

  /** Writes every record in one transaction, or none. */
  saveExchanges(records: readonly SavedExchange[]): void {
    const parsed = records.map((record) => savedExchangeSchema.parse(record))
    withTx(() => { for (const record of parsed) writeExchange(record, 'replace') })
  }
}

/** Restart receipts. Each session keeps only its current run. Delivery is
 * claimed before queueing. One runtime owns these rows: its snapshot avoids SQL
 * reads on live events, and a changed receipt is still written synchronously
 * before work proceeds. */
export class ActiveRuns {
  private readonly runs = new Map<string, { run: RestartRun; payload: string }>()

  constructor() { this.reload() }

  list(): RestartRun[] {
    return Array.from(this.runs.values(), ({ run }) => structuredClone(run))
  }

  get(sessionId: string): RestartRun | undefined {
    const saved = this.runs.get(sessionId)
    return saved ? structuredClone(saved.run) : undefined
  }

  save(run: RestartRun): void {
    const parsed = restartRunSchema.parse(run)
    const payload = JSON.stringify(parsed)
    if (this.runs.get(run.sessionId)?.payload === payload) return
    getDb().prepare(`INSERT INTO runs(session_id, run_id, state, payload, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
      run_id = excluded.run_id, state = excluded.state, payload = excluded.payload, updated_at = excluded.updated_at`)
      .run(run.sessionId, run.runId, run.state, payload, Date.now())
    this.runs.set(run.sessionId, { run: parsed, payload })
  }

  remove(sessionId: string, runId?: string): void {
    const saved = this.runs.get(sessionId)
    if (!saved || (runId && saved.run.runId !== runId)) return
    if (runId) getDb().prepare('DELETE FROM runs WHERE session_id = ? AND run_id = ?').run(sessionId, runId)
    else getDb().prepare('DELETE FROM runs WHERE session_id = ?').run(sessionId)
    this.runs.delete(sessionId)
  }

  claim(run: RestartRun): boolean {
    const claimed = restartRunSchema.parse({ ...run, state: 'delivering' })
    const payload = JSON.stringify(claimed)
    const result = getDb().prepare(`UPDATE runs SET state = 'delivering', payload = ?, updated_at = ?
      WHERE session_id = ? AND run_id = ? AND state != 'delivering'`)
      .run(payload, Date.now(), run.sessionId, run.runId)
    if (Number(result.changes) !== 1) {
      // Another claimant may have changed the receipt. Read it again.
      this.reload()
      return false
    }
    this.runs.set(run.sessionId, { run: claimed, payload })
    return true
  }

  private reload(): void {
    this.runs.clear()
    for (const row of getDb().prepare('SELECT payload FROM runs ORDER BY updated_at, session_id').all()) {
      const run = restartRunSchema.parse(JSON.parse(z.object({ payload: z.string() }).parse(row).payload))
      this.runs.set(run.sessionId, { run, payload: JSON.stringify(run) })
    }
  }
}

function writeExchange(record: SavedExchange, conflict: 'replace' | 'ignore'): void {
  const { deliveryState, deliveryQueueId, reportText, reply, ...fields } = record
  const onConflict = conflict === 'ignore' ? 'DO NOTHING' : `DO UPDATE SET
    sender_session_id = excluded.sender_session_id, target_session_id = excluded.target_session_id,
    run_id = excluded.run_id, state = excluded.state, delivery_state = excluded.delivery_state,
    delivery_queue_id = excluded.delivery_queue_id, payload = excluded.payload, report = excluded.report,
    reply = excluded.reply, settled_at = excluded.settled_at, updated_at = excluded.updated_at`
  getDb().prepare(`INSERT INTO run_exchanges(exchange_id, sender_session_id, target_session_id, run_id, state,
    delivery_state, delivery_queue_id, payload, report, reply, settled_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(exchange_id) ${onConflict}`)
    .run(record.exchangeId, record.senderSessionId, record.targetSessionId, record.runId ?? null, record.state,
      deliveryState ?? null, deliveryQueueId ?? null, JSON.stringify(fields), reportText ?? null, reply ?? null,
      record.settledAt ?? null, Date.now())
}

const legacyQueueSchema = z.object({ version: z.literal(1), entries: z.array(savedQueueEntrySchema) })
const legacyExchangeSchema = z.object({ version: z.literal(1), ...exchangeFields })

function jsonFiles(directory: string): string[] {
  try {
    return readdirSync(directory).filter((name) => name.endsWith('.json')).map((name) => join(directory, name))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

/** Earlier versions wrote one JSON file per session queue and per exchange.
 * Import them in one transaction, then remove them. A crash before removal
 * imports them again; existing rows win. */
function importLegacyReceipts(directory: string): void {
  const queueFiles = jsonFiles(directory)
  const exchangeFiles = jsonFiles(join(directory, 'exchanges'))
  if (!queueFiles.length && !exchangeFiles.length) return
  const queues = queueFiles.map((file) => legacyQueueSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).entries)
  const exchanges = exchangeFiles.map((file) => legacyExchangeSchema.parse(JSON.parse(readFileSync(file, 'utf8'))))
  withTx(() => {
    const now = Date.now()
    for (const entries of queues) {
      entries.forEach((entry, position) => {
        getDb().prepare('INSERT OR IGNORE INTO run_queue(queue_id, session_id, position, payload, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(entry.queueId, entry.sessionId, position, JSON.stringify(entry), now)
      })
    }
    for (const { version: _version, ...record } of exchanges) writeExchange(record, 'ignore')
  })
  for (const file of [...queueFiles, ...exchangeFiles]) rmSync(file, { force: true })
}
