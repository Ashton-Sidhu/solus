import { existsSync, readFileSync } from 'fs'
import { mkdir, rename, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { z } from 'zod'
import { dataDir } from '../platform/paths'
import { createLogger } from '../logger'
import type { SessionStatus } from '../../shared/types'
import type { AttentionEntry, AttentionKind } from '../../shared/attention-types'

const log = createLogger('attention', 'attention-service.ts')

/** Entries only clear when their session is revisited, so a long-idle instance can
 *  accumulate one per finished/failed session forever. Cap the list and evict the
 *  oldest (by `since`) past this size. */
const MAX_ENTRIES = 200

/** Default persisted location: <dataDir>/state/attention.json (respects the
 *  SOLUS_DATA_DIR override that tests and the daemon use). Resolved lazily so
 *  the override can be set before the service is constructed. */
function defaultStatePath(): string {
  return join(dataDir(), 'state', 'attention.json')
}

interface AttentionFile {
  version: 1
  entries: Record<string, AttentionEntry>
}

const attentionFileSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), z.object({
    sessionId: z.string(),
    kind: z.enum(['needs_approval', 'question', 'finished', 'failed']),
    since: z.number(),
    summary: z.string(),
    projectKey: z.string().optional(),
    resolvedBy: z.string().optional(),
  })),
})

/**
 * What a session-status transition should do to the attention entry. Kept pure
 * and exported so the mapping is unit-testable without the control plane. For
 * `awaiting_input` the caller must say whether the pending prompt is a
 * permission (`needs_approval`) or a question, since the status alone can't tell.
 */
export type AttentionAction =
  | { type: 'set'; kind: AttentionKind }
  | { type: 'resolve' }
  | { type: 'ignore' }

export function attentionActionForStatus(
  status: SessionStatus,
  pending: 'permission' | 'question' | null,
): AttentionAction {
  switch (status) {
    case 'awaiting_input':
      if (pending === 'question') return { type: 'set', kind: 'question' }
      if (pending === 'permission') return { type: 'set', kind: 'needs_approval' }
      return { type: 'ignore' }
    case 'completed':
      return { type: 'set', kind: 'finished' }
    case 'failed':
    case 'dead':
      return { type: 'set', kind: 'failed' }
    // A new prompt (→ running/connecting), an answered permission/question
    // (→ running), a cancel/stop (→ interrupted), or a rate-limit stop (→ idle)
    // all clear the active entry.
    case 'running':
    case 'connecting':
    case 'idle':
    case 'interrupted':
      return { type: 'resolve' }
    // awaiting_plan and rate_limited are not attention states in F1.
    default:
      return { type: 'ignore' }
  }
}

/**
 * The `attention-changed` payload is the FULL active list, not a delta. Attention
 * is small (at most one entry per active session), and every client already
 * bootstraps via `listAttention` — shipping the whole list on each change lets
 * consumers replace their state wholesale instead of merging set/clear deltas.
 */
export type AttentionChangeListener = (entries: AttentionEntry[]) => void

/**
 * Per-session needs-attention state. One active entry per session (latest wins).
 * Write-through to disk on every change; loaded at construction so state survives
 * client disconnects and server restarts.
 */
export class AttentionService {
  private entries = new Map<string, AttentionEntry>()
  private listener: AttentionChangeListener | null = null
  private readonly statePath: string

  /** `statePath` is injectable so tests can point at a temp file. */
  constructor(statePath: string = defaultStatePath()) {
    this.statePath = statePath
    this._load()
  }

  onChange(listener: AttentionChangeListener): void {
    this.listener = listener
  }

  /** All active entries, most-recent first. */
  list(): AttentionEntry[] {
    return [...this.entries.values()].sort((a, b) => b.since - a.since)
  }

  get(sessionId: string): AttentionEntry | undefined {
    return this.entries.get(sessionId)
  }

  /** Record/replace the active entry for a session (latest wins). No-op when the
   *  same kind + summary + projectKey is re-asserted, so redundant status calls
   *  don't churn disk or re-broadcast. */
  set(input: { sessionId: string; kind: AttentionKind; summary: string; projectKey?: string }): void {
    const existing = this.entries.get(input.sessionId)
    if (
      existing &&
      existing.kind === input.kind &&
      existing.summary === input.summary &&
      existing.projectKey === input.projectKey
    ) {
      return
    }
    const entry: AttentionEntry = {
      sessionId: input.sessionId,
      kind: input.kind,
      // Keep `since` stable while the same kind persists; reset it when the kind flips.
      since: existing && existing.kind === input.kind ? existing.since : Date.now(),
      summary: input.summary,
    }
    if (input.projectKey) entry.projectKey = input.projectKey
    this.entries.set(input.sessionId, entry)
    this._evictOverflow()
    this._persist()
    this._emit()
  }

  /** Clear the active entry for a session. No-op when nothing is pending. */
  resolve(sessionId: string): void {
    if (!this.entries.delete(sessionId)) return
    this._persist()
    this._emit()
  }

  /** Drop the oldest entries (by `since`) once the list exceeds MAX_ENTRIES. */
  private _evictOverflow(): void {
    const overflow = this.entries.size - MAX_ENTRIES
    if (overflow <= 0) return
    const oldest = [...this.entries.values()].sort((a, b) => a.since - b.since).slice(0, overflow)
    for (const entry of oldest) this.entries.delete(entry.sessionId)
  }

  private _emit(): void {
    try {
      this.listener?.(this.list())
    } catch (err) {
      log.error('attention_changed_listener_failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  private _load(): void {
    if (!existsSync(this.statePath)) return
    try {
      const parsed = attentionFileSchema.parse(JSON.parse(readFileSync(this.statePath, 'utf8')))
      for (const entry of Object.values(parsed.entries)) {
        this.entries.set(entry.sessionId, entry)
      }
      this._evictOverflow()
    } catch (err) {
      log.error('attention_state_load_failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Coalesced async write-through: status transitions arrive in bursts on the
   *  hot event path, and a synchronous whole-file write per transition blocks
   *  the main event loop. Writes chain so the file always ends at the latest
   *  state; losing the tail write on a crash only costs best-effort UI state. */
  private persistDirty = false
  private pendingPersist: Promise<void> | null = null

  /** Resolves once every change made so far has reached disk. */
  async flushPersist(): Promise<void> {
    while (this.pendingPersist) await this.pendingPersist
  }

  private _persist(): void {
    this.persistDirty = true
    if (this.pendingPersist) return
    this.pendingPersist = (async () => {
      while (this.persistDirty) {
        this.persistDirty = false
        try {
          await mkdir(dirname(this.statePath), { recursive: true })
          const body: AttentionFile = { version: 1, entries: Object.fromEntries(this.entries) }
          // Temp + rename: an async truncate-and-write interrupted by process
          // exit would leave a partial file that _load() rejects wholesale.
          const tempPath = `${this.statePath}.tmp`
          await writeFile(tempPath, JSON.stringify(body, null, 2), { mode: 0o600 })
          await rename(tempPath, this.statePath)
        } catch (err) {
          log.error('attention_state_persist_failed', { error: err instanceof Error ? err.message : String(err) })
        }
      }
      this.pendingPersist = null
    })()
  }
}
