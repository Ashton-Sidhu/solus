export const RESPONSE_RECEIPT_TTL_MS = 60_000
export const RESPONSE_RECEIPT_MAX_ENTRIES = 100
export const RESPONSE_RECEIPT_MAX_BYTES = 16 * 1024 * 1024
export const RESPONSE_RECEIPT_MAX_ENTRY_BYTES = 4 * 1024 * 1024
export const RESPONSE_RECEIPT_MAX_IN_FLIGHT = 64
// Editor, Pill, web, and mobile clients can issue independent boot reads at the
// same time. Keep the per-client guard strict without letting one busy surface
// consume the whole host budget and reject routine reads from every other one.
export const RESPONSE_RECEIPT_GLOBAL_MAX_IN_FLIGHT = RESPONSE_RECEIPT_MAX_IN_FLIGHT * 4
export const RESPONSE_RECEIPT_GLOBAL_MAX_BYTES = RESPONSE_RECEIPT_MAX_BYTES

export interface ResponseReceiptBudgetStats {
  inFlight: number
  settledBytes: number
}

export interface ResponseReceiptCacheStats extends ResponseReceiptBudgetStats {
  entries: number
}

export class ResponseReceiptBudget {
  private inFlight = 0
  private settledBytes = 0

  constructor(
    private readonly maxInFlight = RESPONSE_RECEIPT_GLOBAL_MAX_IN_FLIGHT,
    private readonly maxSettledBytes = RESPONSE_RECEIPT_GLOBAL_MAX_BYTES,
  ) {}

  tryStart(): boolean {
    if (this.inFlight >= this.maxInFlight) return false
    this.inFlight += 1
    return true
  }

  finishInFlight(): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
  }

  tryRetain(bytes: number): boolean {
    if (this.settledBytes + bytes > this.maxSettledBytes) return false
    this.settledBytes += bytes
    return true
  }

  releaseRetained(bytes: number): void {
    this.settledBytes = Math.max(0, this.settledBytes - bytes)
  }

  stats(): ResponseReceiptBudgetStats {
    return { inFlight: this.inFlight, settledBytes: this.settledBytes }
  }
}

interface Receipt<T> {
  response: Promise<T>
  settledAt: number | null
  retainedBytes: number
  budgetState: 'in-flight' | 'settled' | null
}

/** Conservative, allocation-light estimate of the graph a settled Promise retains. */
export function estimateRetainedBytes<Value>(value: Value, ceiling = Number.POSITIVE_INFINITY): number {
  const seen = new WeakSet<object>()
  let bytes = 0

  const visit = <Candidate>(candidate: Candidate): void => {
    if (bytes > ceiling || candidate == null) return
    const stringCandidate = z.string().safeParse(candidate)
    if (stringCandidate.success) {
      bytes += 16 + stringCandidate.data.length * 2
      return
    }
    if (z.union([z.number(), z.bigint()]).safeParse(candidate).success) {
      bytes += 8
      return
    }
    if (z.boolean().safeParse(candidate).success) {
      bytes += 4
      return
    }
    const objectCandidate = z.object({}).passthrough().safeParse(candidate)
    if (!objectCandidate.success || seen.has(objectCandidate.data)) return
    seen.add(objectCandidate.data)
    bytes += 48

    if (ArrayBuffer.isView(candidate)) {
      bytes += candidate.byteLength
      return
    }
    if (candidate instanceof ArrayBuffer) {
      bytes += candidate.byteLength
      return
    }
    if (Array.isArray(candidate)) {
      bytes += candidate.length * 8
      for (const item of candidate) {
        visit(item)
        if (bytes > ceiling) break
      }
      return
    }
    for (const [key, item] of Object.entries(objectCandidate.data)) {
      bytes += 8 + key.length * 2
      visit(item)
      if (bytes > ceiling) break
    }
  }

  try {
    visit(value)
  } catch {
    return ceiling + 1
  }
  return bytes
}

/**
 * Deduplicates reconnect retries without turning resolved RPC payloads into an
 * unbounded per-client heap. In-flight work is never evicted or re-executed;
 * settled receipts expire on their own timer and obey count + byte budgets.
 */
export class ResponseReceiptCache<T> {
  private entries = new Map<string, Receipt<T>>()
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly overloadedValue: () => T,
    private readonly sharedBudget?: ResponseReceiptBudget,
  ) {}

  getOrCreate(requestId: string, create: () => Promise<T>): Promise<T> {
    this.prune()
    const existing = this.entries.get(requestId)
    if (existing) return existing.response

    let inFlight = 0
    for (const receipt of this.entries.values()) if (receipt.settledAt === null) inFlight++
    if (inFlight >= RESPONSE_RECEIPT_MAX_IN_FLIGHT) {
      return Promise.resolve(this.overloadedValue())
    }
    if (this.sharedBudget && !this.sharedBudget.tryStart()) {
      return Promise.resolve(this.overloadedValue())
    }

    let response: Promise<T>
    try {
      response = create()
    } catch (error) {
      this.sharedBudget?.finishInFlight()
      throw error
    }
    const receipt: Receipt<T> = {
      response,
      settledAt: null,
      retainedBytes: 0,
      budgetState: this.sharedBudget ? 'in-flight' : null,
    }
    this.entries.set(requestId, receipt)
    void response.then(
      (value) => this.settle(requestId, receipt, value),
      () => this.remove(requestId, receipt),
    )
    return response
  }

  close(): void {
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer)
    this.cleanupTimer = null
    for (const [requestId, receipt] of this.entries) this.deleteReceipt(requestId, receipt)
  }

  stats(): ResponseReceiptCacheStats {
    let inFlight = 0
    let settledBytes = 0
    for (const receipt of this.entries.values()) {
      if (receipt.settledAt === null) inFlight++
      else settledBytes += receipt.retainedBytes
    }
    return { entries: this.entries.size, inFlight, settledBytes }
  }

  private settle(requestId: string, receipt: Receipt<T>, value: T): void {
    if (receipt.budgetState === 'in-flight') {
      this.sharedBudget?.finishInFlight()
      receipt.budgetState = null
    }
    if (this.entries.get(requestId) !== receipt) return
    const retainedBytes = estimateRetainedBytes(value, RESPONSE_RECEIPT_MAX_ENTRY_BYTES)
    if (retainedBytes > RESPONSE_RECEIPT_MAX_ENTRY_BYTES) {
      this.deleteReceipt(requestId, receipt)
      return
    }
    if (this.sharedBudget && !this.sharedBudget.tryRetain(retainedBytes)) {
      this.deleteReceipt(requestId, receipt)
      return
    }
    receipt.settledAt = Date.now()
    receipt.retainedBytes = retainedBytes
    if (this.sharedBudget) receipt.budgetState = 'settled'
    this.prune()
    this.scheduleCleanup()
  }

  private remove(requestId: string, receipt: Receipt<T>): void {
    if (receipt.budgetState === 'in-flight') {
      this.sharedBudget?.finishInFlight()
      receipt.budgetState = null
    }
    this.deleteReceipt(requestId, receipt)
  }

  private deleteReceipt(requestId: string, receipt: Receipt<T>): void {
    if (this.entries.get(requestId) !== receipt) return
    this.entries.delete(requestId)
    // Closing a cache must not release global in-flight admission: deleting a
    // reconnect receipt does not stop the underlying RPC. Its Promise handler
    // releases admission when the work actually settles.
    if (receipt.budgetState === 'settled') {
      this.sharedBudget?.releaseRetained(receipt.retainedBytes)
      receipt.budgetState = null
    }
  }

  private prune(): void {
    const now = Date.now()
    for (const [requestId, receipt] of this.entries) {
      if (receipt.settledAt !== null && now - receipt.settledAt >= RESPONSE_RECEIPT_TTL_MS) {
        this.deleteReceipt(requestId, receipt)
      }
    }

    while (true) {
      const stats = this.stats()
      const settledEntries = stats.entries - stats.inFlight
      if (settledEntries <= RESPONSE_RECEIPT_MAX_ENTRIES && stats.settledBytes <= RESPONSE_RECEIPT_MAX_BYTES) break
      let oldest: { requestId: string; settledAt: number } | null = null
      for (const [requestId, receipt] of this.entries) {
        if (receipt.settledAt === null) continue
        if (!oldest || receipt.settledAt < oldest.settledAt) oldest = { requestId, settledAt: receipt.settledAt }
      }
      if (!oldest) break
      const receipt = this.entries.get(oldest.requestId)
      if (receipt) this.deleteReceipt(oldest.requestId, receipt)
    }
  }

  private scheduleCleanup(): void {
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer)
    let nextExpiry = Number.POSITIVE_INFINITY
    for (const receipt of this.entries.values()) {
      if (receipt.settledAt !== null) {
        nextExpiry = Math.min(nextExpiry, receipt.settledAt + RESPONSE_RECEIPT_TTL_MS)
      }
    }
    if (!Number.isFinite(nextExpiry)) {
      this.cleanupTimer = null
      return
    }
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = null
      this.prune()
      this.scheduleCleanup()
    }, Math.max(1, nextExpiry - Date.now()))
    this.cleanupTimer.unref?.()
  }
}
import { z } from 'zod'
