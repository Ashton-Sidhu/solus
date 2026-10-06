import type { QueuedPromptReason, SessionRunInput } from '@solus/contracts/types'
import type { User } from '@solus/contracts/user'
import type { SessionQueueMutation } from '@solus/contracts/session-queue'
import type { RunLedger, SavedQueueEntry } from '../../data/sessions/run-ledger'
import type { SessionRunRequest } from '../session-runtime'

export interface QueuedRequest {
  queueId: string
  prompt: string
  sessionId: string
  deviceId?: string
  run: SessionRunRequest
  reason: QueuedPromptReason
  resolve(value: void): void
  reject(reason: Error): void
  enqueuedAt: number
  sourceSessionId?: string
  rateLimitSessionId?: string
  releaseAt?: number
  rateLimitType?: string
  kind?: 'prompt' | 'provider_switch'
  revision?: number
  held?: boolean
  error?: string
  author?: User
  requestedInput?: SessionRunInput
  started?: boolean
}

/** Owns ordered entries. The run ledger keeps their crash receipts; live
 * promises and tools stay in this process. A change is written first, and
 * memory is restored when the write fails. Restored work is held until its
 * author resumes it. */
export class SessionRequestQueue {
  private readonly queues = new Map<string, QueuedRequest[]>()
  private readonly claimed = new Map<string, QueuedRequest[]>()

  constructor(private readonly ledger?: RunLedger) {
    for (const entry of ledger?.loadQueue() ?? []) {
      const queue = this.queues.get(entry.sessionId) ?? []
      queue.push({
        ...entry, held: true,
        error: entry.started ? 'The host stopped after this entry started. Check its history before resuming.' : entry.error,
        run: {
          input: entry.input, options: entry.options, tools: [], sessionId: entry.sessionId,
          target: { kind: 'session', sessionId: entry.sessionId }, runId: entry.runId, exchangeIds: entry.exchangeIds, reportExchangeIds: entry.reportExchangeIds,
        },
        resolve: () => {}, reject: () => {},
      })
      this.queues.set(entry.sessionId, queue)
    }
  }

  get size(): number { return new Set([...this.queues.keys(), ...this.claimed.keys()]).size }
  get(sessionId: string): QueuedRequest[] | undefined { return this.queues.get(sessionId) }
  values(): IterableIterator<QueuedRequest[]> { return this.queues.values() }

  enqueue(entry: QueuedRequest, position: 'first' | 'last' = 'last'): void {
    const queue = this.queues.get(entry.sessionId) ?? []
    entry.revision ??= 0
    if (position === 'first') queue.unshift(entry)
    else queue.push(entry)
    this.queues.set(entry.sessionId, queue)
    try { this.save(entry.sessionId) } catch (error) {
      queue.splice(queue.indexOf(entry), 1)
      if (!queue.length) this.queues.delete(entry.sessionId)
      throw error
    }
  }

  hasPrompt(sessionId: string, clientPromptId: string): boolean {
    return [...(this.queues.get(sessionId) ?? []), ...(this.claimed.get(sessionId) ?? [])]
      .some((entry) => entry.run.options.clientPromptId === clientPromptId)
  }

  lastSwitchInput(sessionId: string): SessionRunInput | undefined {
    return this.queues.get(sessionId)?.findLast((entry) => entry.kind === 'provider_switch')?.run.input
      ?? this.claimed.get(sessionId)?.findLast((entry) => entry.kind === 'provider_switch')?.run.input
  }

  edit(entry: QueuedRequest, mutation: Extract<SessionQueueMutation, { kind: 'edit' }>, reports?: { reportExchangeIds?: string[]; exchangeIds?: string[] }): void {
    if (entry.kind === 'provider_switch') throw new Error('Remove the switch and queue a new provider choice.')
    const options = entry.run.options
    const oldText = options.displayPrompt ?? entry.prompt
    const last = options.prompt.lastIndexOf(oldText)
    let prompt = last >= 0 ? options.prompt.slice(0, last) + mutation.text + options.prompt.slice(last + oldText.length) : mutation.text
    if (mutation.attachmentContext !== undefined) {
      const oldContext = options.queueAttachmentContext ?? ''
      if (oldContext && prompt.startsWith(oldContext + '\n\n')) prompt = prompt.slice(oldContext.length + 2)
      if (mutation.attachmentContext) prompt = mutation.attachmentContext + '\n\n' + prompt
    }
    const previousOptions = { ...options }
    const previousReportIds = entry.run.reportExchangeIds
    const previousExchangeIds = entry.run.exchangeIds
    const previousText = entry.prompt
    const previousRevision = entry.revision
    entry.run.options = { ...options, prompt, displayPrompt: mutation.text }
    if (mutation.attachmentContext !== undefined) entry.run.options.queueAttachmentContext = mutation.attachmentContext
    if (mutation.attachments !== undefined) entry.run.options.queueAttachments = mutation.attachments
    if (mutation.images !== undefined) entry.run.options.imageAttachments = mutation.images
    if (mutation.imageRefs !== undefined) entry.run.options.imageAttachmentRefs = mutation.imageRefs
    entry.prompt = mutation.text
    entry.revision = (entry.revision ?? 0) + 1
    if (reports?.reportExchangeIds) entry.run.reportExchangeIds = reports.reportExchangeIds
    if (reports?.exchangeIds) entry.run.exchangeIds = reports.exchangeIds
    try { this.save(entry.sessionId) } catch (error) {
      entry.run.options = previousOptions
      entry.run.reportExchangeIds = previousReportIds
      entry.run.exchangeIds = previousExchangeIds
      entry.prompt = previousText
      entry.revision = previousRevision
      throw error
    }
  }

  /** A moved or removed switch changes the provider for following prompts.
   * Keep the original turn options so moving a prompt back restores them. */
  rebind(sessionId: string, current: SessionRunInput): void {
    const previous = (this.queues.get(sessionId) ?? []).map((entry) => ({ entry, input: entry.run.input, revision: entry.revision }))
    let target: SessionRunInput | undefined
    for (const entry of this.queues.get(sessionId) ?? []) {
      if (entry.kind === 'provider_switch') { target = entry.run.input; continue }
      const requested = entry.requestedInput ?? entry.run.input
      const effective = target ?? (requested.provider === current.provider ? requested : current)
      const input = entry.run.input
      if (input.provider !== effective.provider || input.model !== effective.model || input.reasoningEffort !== effective.reasoningEffort || input.fastMode !== effective.fastMode || input.contextWindow !== effective.contextWindow) {
        entry.revision = (entry.revision ?? 0) + 1
      }
      entry.run.input = { ...requested, provider: effective.provider, model: effective.model,
        preferredModel: effective.preferredModel, reasoningEffort: effective.reasoningEffort,
        contextWindow: effective.contextWindow, fastMode: effective.fastMode,
        agentSessionId: target ? null : current.agentSessionId }
    }
    try { this.save(sessionId) } catch (error) {
      for (const saved of previous) {
        saved.entry.run.input = saved.input
        saved.entry.revision = saved.revision
      }
      throw error
    }
  }

  /** Retain the claimed receipt until settlement, so a crash never silently
   * loses an accepted prompt or automatically repeats an uncertain run. */
  claim(sessionId: string): QueuedRequest | undefined {
    const entry = this.queues.get(sessionId)?.[0]
    if (!entry || entry.held) return undefined
    const claimed = this.claimed.get(sessionId) ?? []
    claimed.push(entry)
    this.claimed.set(sessionId, claimed)
    this.queues.get(sessionId)!.shift()
    try { this.save(sessionId) } catch (error) {
      claimed.pop()
      this.queues.get(sessionId)!.unshift(entry)
      if (!claimed.length) this.claimed.delete(sessionId)
      throw error
    }
    return entry
  }

  settle(entry: QueuedRequest, error?: string): void {
    const claimed = this.claimed.get(entry.sessionId)
    const index = claimed?.indexOf(entry) ?? -1
    const previous = { error: entry.error, held: entry.held, revision: entry.revision }
    if (index >= 0) claimed!.splice(index, 1)
    if (error) {
      entry.error = error
      entry.held = true
      entry.revision = (entry.revision ?? 0) + 1
      const queue = this.queues.get(entry.sessionId) ?? []
      queue.unshift(entry)
      this.queues.set(entry.sessionId, queue)
    }
    try { this.save(entry.sessionId) } catch (saveError) {
      if (error) {
        const queue = this.queues.get(entry.sessionId)
        const pendingIndex = queue?.indexOf(entry) ?? -1
        if (pendingIndex >= 0) queue!.splice(pendingIndex, 1)
        if (!queue?.length) this.queues.delete(entry.sessionId)
        entry.error = previous.error
        entry.held = previous.held
        entry.revision = previous.revision
      }
      if (index >= 0) claimed!.splice(index, 0, entry)
      throw saveError
    }
  }

  remove(sessionId: string, queueId: string): QueuedRequest | undefined {
    const queue = this.queues.get(sessionId)
    const index = queue?.findIndex((entry) => entry.queueId === queueId) ?? -1
    if (index < 0) return undefined
    const [entry] = queue!.splice(index, 1)
    try { this.save(sessionId) } catch (error) { queue!.splice(index, 0, entry!); throw error }
    return entry
  }

  /** If storage is unavailable after delivery, expose the uncertain receipt
   * as held work. Its saved started receipt remains safe on restart. */
  holdUncertain(entry: QueuedRequest, error: string): void {
    const claimed = this.claimed.get(entry.sessionId)
    const index = claimed?.indexOf(entry) ?? -1
    if (index >= 0) claimed!.splice(index, 1)
    if (!claimed?.length) this.claimed.delete(entry.sessionId)
    const queue = this.queues.get(entry.sessionId) ?? []
    if (!queue.includes(entry)) queue.unshift(entry)
    this.queues.set(entry.sessionId, queue)
    entry.held = true
    entry.error = error
    entry.revision = (entry.revision ?? 0) + 1
  }

  move(sessionId: string, queueId: string, beforeQueueId: string | null): void {
    const queue = this.queues.get(sessionId) ?? []
    const index = queue.findIndex((entry) => entry.queueId === queueId)
    if (index < 0 || beforeQueueId === queueId) throw new Error('Queue entry changed. Refresh the queue.')
    const before = beforeQueueId === null ? queue.length : queue.findIndex((entry) => entry.queueId === beforeQueueId)
    if (before < 0) throw new Error('Queue destination changed. Refresh the queue.')
    const [entry] = queue.splice(index, 1)
    queue.splice(before > index ? before - 1 : before, 0, entry)
    const revisions = queue.map((item) => item.revision)
    for (const item of queue) item.revision = (item.revision ?? 0) + 1
    try { this.save(sessionId) } catch (error) {
      queue.forEach((item, position) => { item.revision = revisions[position] })
      queue.splice(queue.indexOf(entry), 1)
      queue.splice(index, 0, entry)
      throw error
    }
  }

  save(sessionId: string): void {
    const pending = this.queues.get(sessionId) ?? []
    const active = this.claimed.get(sessionId) ?? []
    const entries: SavedQueueEntry[] = [...active, ...pending].map((entry) => ({
      queueId: entry.queueId, sessionId, prompt: entry.prompt, enqueuedAt: entry.enqueuedAt,
      reason: entry.reason, revision: entry.revision ?? 0, kind: entry.kind ?? 'prompt', held: !!entry.held,
      error: entry.error, input: entry.run.input, options: entry.run.options,
      requestedInput: entry.requestedInput,
      author: entry.run.actor?.user ?? entry.author, sourceSessionId: entry.sourceSessionId,
      rateLimitSessionId: entry.rateLimitSessionId, releaseAt: entry.releaseAt, rateLimitType: entry.rateLimitType,
      runId: entry.run.runId, exchangeIds: entry.run.exchangeIds, reportExchangeIds: entry.run.reportExchangeIds, started: entry.started || active.includes(entry),
    }))
    this.ledger?.saveQueue(sessionId, entries)
    if (!pending.length) this.queues.delete(sessionId)
    if (!active.length) this.claimed.delete(sessionId)
  }
}
