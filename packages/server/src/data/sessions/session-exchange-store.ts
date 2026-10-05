import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const savedExchangeSchema = z.object({
  version: z.literal(1),
  exchangeId: z.string(), kind: z.enum(['create', 'prompt']),
  senderSessionId: z.string(), senderAgentSessionId: z.string(),
  targetSessionId: z.string(), targetAgentSessionId: z.string(),
  provider: z.enum(['claude-code', 'codex', 'opencode']), notify: z.boolean(),
  state: z.enum(['dispatched', 'queued', 'running', 'awaiting_input', 'rate_limited', 'waiting_for_children', 'settled']),
  runId: z.string().optional(), parentExchangeIds: z.array(z.string()),
  fingerprint: z.string().optional(), disposition: z.enum(['started', 'steered', 'queued']).optional(),
  dispatchedAt: z.number(), settledAt: z.number().optional(),
  outcome: z.enum(['completed', 'failed', 'interrupted']).optional(),
  outputsText: z.string(), reportText: z.string().optional(),
  deliveryState: z.enum(['pending', 'queued', 'accepted', 'disposed']).optional(),
  deliveryQueueId: z.string().optional(),
})

export type SavedExchange = z.infer<typeof savedExchangeSchema>

/** Host-local execution receipts, like the session queue. One atomic record
 * commits a result with its pending report. No provider callbacks, credentials,
 * or permission grants are stored here. Records are not mirrored domain data. */
export class SessionExchangeStore {
  constructor(private readonly directory: string) {}

  load(): SavedExchange[] {
    let names: string[]
    try { names = readdirSync(this.directory) } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
    const records: SavedExchange[] = []
    for (const name of names.filter((file) => file.endsWith('.json'))) {
      const file = join(this.directory, name)
      const record = savedExchangeSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
      // Keep active work and undelivered results for as long as needed. Closed
      // receipts provide a thirty-day retry window, without growing forever.
      if (record.state === 'settled' && (record.deliveryState === 'accepted' || record.deliveryState === 'disposed')
        && (record.settledAt ?? record.dispatchedAt) < Date.now() - 30 * 86_400_000) {
        rmSync(file)
      } else records.push(record)
    }
    return records
  }

  save(record: SavedExchange): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const file = join(this.directory, `${createHash('sha256').update(record.exchangeId).digest('hex')}.json`)
    const pending = `${file}.pending`
    writeFileSync(pending, JSON.stringify(savedExchangeSchema.parse(record)), { mode: 0o600 })
    renameSync(pending, file)
  }
}
