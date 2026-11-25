import { z } from 'zod'
import type { PromptImageRef } from '@solus/contracts/types'
import { queueAttachmentSchema, type QueueAttachment } from '@solus/contracts/session-queue'
import { forwardCompatibleArray } from './forward-compat'
import { HostGoneError, TransportDisconnectedError } from './rpc-error'

/**
 * The durable send outbox (dispatch-client step 6): queued work survives a
 * dead host and drains when its supervisor reports live. Entries are keyed by
 * the renderer's existing `clientPromptId` — generated before dispatch, so a
 * drain can never double-send what the host already accepted.
 *
 * Failure classification is the step's contract: a transient failure (the
 * transport died under the send) leaves the entry queued for the next server
 * session; a domain failure (the host answered "no") parks the entry with its
 * error for the user's delivery decision — `wait | remove | send`.
 */

export type DeliveryAction = 'wait' | 'remove' | 'send'

/** The prompt call a drain replays verbatim. Display text lives on the
 *  record's own `text`; everything here goes back into the RPC. */
export interface OutboxPromptPayload {
  taskId?: string
  taskHostId?: string
  prompt: string
  displayPrompt: string
  delivery?: string
  imageAttachments?: Array<{ mimeType: string; dataUrl: string }>
  /** Host-stored images, replayed by reference. A drain can outlive the
   *  composer, so the ref is what survives — the bytes were never held here. */
  imageAttachmentRefs?: PromptImageRef[]
  queueAttachments?: QueueAttachment[]
  queueAttachmentContext?: string
}

export interface OutboxRecord {
  /** Client-generated idempotent id — the renderer's `clientPromptId`. */
  clientPromptId: string
  sessionId: string
  accountScope?: string
  text: string
  enqueuedAt: number
  attempts: number
  /** A domain failure's message. Null while queued or transiently failed. */
  lastError: string | null
  payload?: OutboxPromptPayload
}

const KEY_PREFIX = 'solus.sendOutbox.v1.'

/** The synchronous part of `Storage` the outbox uses. The browser passes
 *  `localStorage`; the native client passes its own key-value store. */
export interface OutboxStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const outboxRecordSchema = z.looseObject({
  clientPromptId: z.string().min(1),
  sessionId: z.string().min(1),
  accountScope: z.string().optional(),
  text: z.string().catch(''),
  enqueuedAt: z.number().catch(0),
  attempts: z.number().catch(0),
  lastError: z.string().nullable().catch(null),
  payload: z.looseObject({
    taskId: z.string().optional(),
    taskHostId: z.string().optional(),
    prompt: z.string(),
    displayPrompt: z.string().catch(''),
    delivery: z.string().optional().catch(undefined),
    queueAttachments: forwardCompatibleArray(queueAttachmentSchema).optional().catch(undefined),
    queueAttachmentContext: z.string().optional().catch(undefined),
    imageAttachments: forwardCompatibleArray(z.looseObject({
      mimeType: z.string(),
      dataUrl: z.string(),
    })).optional().catch(undefined),
    imageAttachmentRefs: forwardCompatibleArray(z.looseObject({
      mimeType: z.string(),
      hostPath: z.string(),
      name: z.string().optional(),
    })).optional().catch(undefined),
  }).optional().catch(undefined),
})
const outboxSchema = forwardCompatibleArray(outboxRecordSchema)

// This classifier IS the I/O boundary for a caught send failure — there is
// no schema for a thrown value beyond the transport's own error class.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function classifySendFailure(error: unknown): 'transient' | 'domain' {
  // A gone host never comes back, so its send fails like a refusal.
  if (error instanceof HostGoneError) return 'domain'
  if (error instanceof TransportDisconnectedError) return 'transient'
  return 'domain'
}

export class SendOutbox {
  private draining = new Set<string>()

  constructor(private readonly storage: () => OutboxStorage = () => localStorage) {}

  /** Queue (or re-queue) one prompt for a host. Same id replaces in place —
   *  an edit before delivery is the same message, not a second one. */
  enqueue(serverId: string, record: Omit<OutboxRecord, 'attempts' | 'lastError'>): boolean {
    const records = this.entriesFor(serverId)
    const entry: OutboxRecord = { ...record, attempts: 0, lastError: null }
    const at = records.findIndex((candidate) => candidate.clientPromptId === record.clientPromptId)
    if (at >= 0) records[at] = entry
    else records.push(entry)
    return this.#write(serverId, records)
  }

  entriesFor(serverId: string, accountScope?: string): OutboxRecord[] {
    let raw: string | null = null
    try {
      raw = this.storage().getItem(KEY_PREFIX + serverId)
    } catch {
      return []
    }
    if (!raw) return []
    try {
      const decoded = outboxSchema.safeParse(JSON.parse(raw))
      if (decoded.success) {
        // SAFETY: Every surviving element passed outboxRecordSchema, whose
        // required fields mirror OutboxRecord; loose keys widen, never narrow.
        const records = decoded.data as OutboxRecord[]
        return accountScope === undefined ? records : records.filter((entry) => entry.accountScope === undefined || entry.accountScope === accountScope)
      }
    } catch {}
    // Delete-and-miss: a corrupt queue must not re-fail every drain.
    this.forgetHost(serverId)
    return []
  }

  /** The `remove` delivery action, and the cleanup after a confirmed send. */
  remove(serverId: string, clientPromptId: string): void {
    const records = this.entriesFor(serverId)
      .filter((candidate) => candidate.clientPromptId !== clientPromptId)
    this.#write(serverId, records)
  }

  /** Forgetting a host is total: its queued work leaves with it. */
  forgetHost(serverId: string): void {
    try {
      this.storage().removeItem(KEY_PREFIX + serverId)
    } catch {}
  }

  /**
   * Deliver a host's queue in arrival order. Called when the host's
   * supervisor reports live; re-entrant calls for the same host are dropped.
   * A parked entry (domain failure) is skipped until the user's `send`
   * releases it by clearing `lastError` through `retry`.
   */
  async drain(
    serverId: string,
    send: (record: OutboxRecord) => Promise<void>,
    accountScope?: string,
  ): Promise<void> {
    const key = JSON.stringify([serverId, accountScope])
    if (this.draining.has(key)) return
    this.draining.add(key)
    try {
      for (const record of this.entriesFor(serverId, accountScope)) {
        // A prior send may await for seconds. Cancellation/removal during that
        // wait must win over this drain's original snapshot.
        const records = this.entriesFor(serverId)
        const current = records.find((entry) => entry.clientPromptId === record.clientPromptId)
        if (!current || current.lastError !== null) continue
        if (accountScope !== undefined) {
          if (current.accountScope !== undefined && current.accountScope !== accountScope) continue
          // Older mobile records had only a host and session. Bind one before its first scoped replay.
          if (current.accountScope === undefined) {
            current.accountScope = accountScope
            if (!this.#write(serverId, records)) return
          }
        }
        try {
          await send(current)
          this.remove(serverId, record.clientPromptId)
        } catch (error) {
          if (classifySendFailure(error) === 'transient') {
            // The transport died under the send: the entry stays queued for
            // the next server session, untouched.
            this.#update(serverId, record.clientPromptId, (entry) => {
              entry.attempts += 1
            })
            return
          }
          // The host answered "no": park the entry with the domain error and
          // keep draining — one refused message must not dam the queue.
          this.#update(serverId, record.clientPromptId, (entry) => {
            entry.attempts += 1
            entry.lastError = error instanceof Error ? error.message : String(error)
          })
        }
      }
    } finally {
      this.draining.delete(key)
    }
  }

  /** The `send` delivery action on a parked entry: clear the domain error so
   *  the next drain carries it again. */
  retry(serverId: string, clientPromptId: string): void {
    this.#update(serverId, clientPromptId, (entry) => {
      entry.lastError = null
    })
  }

  #update(serverId: string, clientPromptId: string, mutate: (entry: OutboxRecord) => void): void {
    const records = this.entriesFor(serverId)
    const entry = records.find((candidate) => candidate.clientPromptId === clientPromptId)
    if (!entry) return
    mutate(entry)
    this.#write(serverId, records)
  }

  #write(serverId: string, records: OutboxRecord[]): boolean {
    try {
      this.storage().setItem(KEY_PREFIX + serverId, JSON.stringify(records))
      return true
    } catch {
      return false
    }
  }
}

export const sendOutbox = new SendOutbox()
