import { SvelteMap } from 'svelte/reactivity'
import type { CloudQueuedPrompt } from '@solus/contracts/types'
import { uuid } from '@solus/contracts/uuid'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import { toasts } from '../../lib/toasts'
import {
  optimisticQueuedPrompt,
  reconcileQueuedPrompts,
  settleQueuedPrompt,
  withQueuedPromptState,
  withoutQueuedPrompt,
} from '../../components/session/record/lib/cloud-queue'

/**
 * The durable prompt queue of a cloud session whose runner is away
 * (docs/plans/cloud-service-model.md, P2). The cloud host owns every row; this
 * store caches what it answered per (host, session), re-reads on
 * `session.promptQueueChanged`, and draws a send at once so the composer never
 * waits on the round trip.
 */

function queueKey(serverId: string, sessionId: string): string {
  return `${serverId}|${sessionId}`
}

const EMPTY_QUEUE: readonly CloudQueuedPrompt[] = []

export class CloudQueueStore {
  readonly queues = new SvelteMap<string, CloudQueuedPrompt[]>()
  readonly errors = new SvelteMap<string, string>()
  private readonly loads = new Map<string, Promise<CloudQueuedPrompt[]>>()
  private stopWatching: (() => void) | null = null

  /** Subscribe once; a change on any host re-reads the queues this client has open. */
  watch(): void {
    if (this.stopWatching) return
    this.stopWatching = subscribeAllHosts('session.promptQueueChanged', (serverId, { sessionId }) => {
      if (this.queues.has(queueKey(serverId, sessionId))) void this.load(serverId, sessionId)
    })
  }

  queueFor(serverId: string, sessionId: string): readonly CloudQueuedPrompt[] {
    return this.queues.get(queueKey(serverId, sessionId)) ?? EMPTY_QUEUE
  }

  errorFor(serverId: string, sessionId: string): string | null {
    return this.errors.get(queueKey(serverId, sessionId)) ?? null
  }

  async load(serverId: string, sessionId: string): Promise<CloudQueuedPrompt[]> {
    this.watch()
    const key = queueKey(serverId, sessionId)
    const inFlight = this.loads.get(key)
    if (inFlight) return inFlight
    const load = serverConnections.apiFor(serverId).sessionPromptQueueList(sessionId)
      .then((loaded) => {
        const next = reconcileQueuedPrompts(this.queues.get(key) ?? [], loaded)
        this.queues.set(key, next)
        this.errors.delete(key)
        return next
      })
      .catch((error) => {
        this.errors.set(key, error instanceof Error ? error.message : String(error))
        if (!this.queues.has(key)) this.queues.set(key, [])
        return this.queues.get(key) ?? []
      })
      .finally(() => { this.loads.delete(key) })
    this.loads.set(key, load)
    return load
  }

  /** Draw the bubble, then ask the host. Answers whether the prompt is on the queue. */
  async enqueue(serverId: string, sessionId: string, text: string, author: CloudQueuedPrompt['author']): Promise<boolean> {
    const key = queueKey(serverId, sessionId)
    const clientPromptId = uuid()
    const local = optimisticQueuedPrompt({ sessionId, text, clientPromptId, author, now: Date.now() })
    this.queues.set(key, [...(this.queues.get(key) ?? []), local])
    try {
      const answer = await serverConnections.apiFor(serverId).sessionPromptEnqueue({ sessionId, text, clientPromptId })
      this.queues.set(key, settleQueuedPrompt(this.queues.get(key) ?? [], clientPromptId, answer))
      return true
    } catch (error) {
      this.queues.set(key, withoutQueuedPrompt(this.queues.get(key) ?? [], local.queueId))
      toasts.error(error instanceof Error ? error.message : 'Could not queue the prompt')
      return false
    }
  }

  async cancel(serverId: string, sessionId: string, queueId: string): Promise<void> {
    const key = queueKey(serverId, sessionId)
    this.queues.set(key, withQueuedPromptState(this.queues.get(key) ?? [], queueId, 'cancelled'))
    try {
      await serverConnections.apiFor(serverId).sessionPromptQueueCancel({ queueId })
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : 'Could not cancel the prompt')
    }
    // The host's list is the truth either way: a claim may have beaten the cancel.
    await this.load(serverId, sessionId)
  }
}

export const cloudQueueStore = new CloudQueueStore()
