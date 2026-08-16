import { z } from 'zod'
import { forwardCompatibleArray } from './forward-compat'
import { TransportDisconnectedError } from './ws-transport'

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
  prompt: string
  displayPrompt: string
  delivery?: string
  imageAttachments?: Array<{ mimeType: string; dataUrl: string }>
}

export interface OutboxRecord {
  /** Client-generated idempotent id — the renderer's `clientPromptId`. */
  clientPromptId: string
  sessionId: string
  text: string
  enqueuedAt: number
  attempts: number
  /** A domain failure's message. Null while queued or transiently failed. */
  lastError: string | null
  payload?: OutboxPromptPayload
}

const KEY_PREFIX = 'solus.sendOutbox.v1.'

const outboxRecordSchema = z.looseObject({
  clientPromptId: z.string().min(1),
  sessionId: z.string().min(1),
  text: z.string().catch(''),
  enqueuedAt: z.number().catch(0),
  attempts: z.number().catch(0),
  lastError: z.string().nullable().catch(null),
  payload: z.looseObject({
    prompt: z.string(),
    displayPrompt: z.string().catch(''),
    delivery: z.string().optional().catch(undefined),
    imageAttachments: forwardCompatibleArray(z.looseObject({
      mimeType: z.string(),
      dataUrl: z.string(),
    })).optional().catch(undefined),
  }).optional().catch(undefined),
})
const outboxSchema = forwardCompatibleArray(outboxRecordSchema)

// This classifier IS the I/O boundary for a caught send failure — there is
// no schema for a thrown value beyond the transport's own error class.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function classifySendFailure(error: unknown): 'transient' | 'domain' {
  if (error instanceof TransportDisconnectedError) return 'transient'
  return 'domain'
}

export class SendOutbox {
  private draining = new Set<string>()

  /** Queue (or re-queue) one prompt for a host. Same id replaces in place —
   *  an edit before delivery is the same message, not a second one. */
  enqueue(serverId: string, record: Omit<OutboxRecord, 'attempts' | 'lastError'>): void {
    const records = this.entriesFor(serverId)
    const entry: OutboxRecord = { ...record, attempts: 0, lastError: null }
    const at = records.findIndex((candidate) => candidate.clientPromptId === record.clientPromptId)
    if (at >= 0) records[at] = entry
    else records.push(entry)
    this.#write(serverId, records)
  }

  entriesFor(serverId: string): OutboxRecord[] {
    let raw: string | null = null
    try {
      raw = localStorage.getItem(KEY_PREFIX + serverId)
    } catch {
      return []
    }
    if (!raw) return []
    try {
      const decoded = outboxSchema.safeParse(JSON.parse(raw))
      if (decoded.success) {
        // SAFETY: Every surviving element passed outboxRecordSchema, whose
        // required fields mirror OutboxRecord; loose keys widen, never narrow.
        return decoded.data as OutboxRecord[]
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
      localStorage.removeItem(KEY_PREFIX + serverId)
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
  ): Promise<void> {
    if (this.draining.has(serverId)) return
    this.draining.add(serverId)
    try {
      for (const record of this.entriesFor(serverId)) {
        if (record.lastError !== null) continue
        try {
          await send(record)
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
      this.draining.delete(serverId)
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

  #write(serverId: string, records: OutboxRecord[]): void {
    try {
      localStorage.setItem(KEY_PREFIX + serverId, JSON.stringify(records))
    } catch {}
  }
}

export const sendOutbox = new SendOutbox()
