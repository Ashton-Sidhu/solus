import type { HostApi } from './host-api'
import type { McpAppRequest, McpAppSnapshot } from '@solus/contracts/mcp-apps'

export type McpAppRead =
  | { phase: 'idle' | 'loading' }
  | { phase: 'ready'; snapshot: McpAppSnapshot }
  | { phase: 'error'; message: string }

const IDLE: McpAppRead = { phase: 'idle' }
/** How many app bodies are kept; beyond it, the ones no card observes are dropped. */
const KEPT_VALUES = 4

/**
 * Immutable app snapshots of one host. Readers of one app share its read; an
 * app nobody observes is dropped beyond a few. A failed read can be retried.
 */
export class McpAppStore {
  private readonly values = new Map<string, McpAppRead>()
  private readonly reads = new Map<string, Promise<void>>()
  private readonly listeners = new Map<string, Set<() => void>>()

  constructor(private readonly api: Pick<HostApi, 'mcpAppRead'>) {}

  read(request: McpAppRequest): McpAppRead {
    return this.values.get(keyOf(request)) ?? IDLE
  }

  subscribe(request: McpAppRequest, listener: () => void): () => void {
    const key = keyOf(request)
    let listeners = this.listeners.get(key)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(key, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.listeners.delete(key)
      this.trim()
    }
  }

  load(request: McpAppRequest): Promise<void> {
    const key = keyOf(request)
    const pending = this.reads.get(key)
    if (pending) return pending
    if (this.values.get(key)?.phase === 'ready') return Promise.resolve()
    this.set(key, { phase: 'loading' })
    const read = this.api.mcpAppRead(request)
      .then(
        (snapshot) => this.set(key, { phase: 'ready', snapshot }),
        (error) => this.set(key, { phase: 'error', message: error instanceof Error ? error.message : 'Could not load this app.' }),
      )
      .finally(() => {
        this.reads.delete(key)
        this.trim()
      })
    this.reads.set(key, read)
    return read
  }

  /** Stores a value as the most recent one and tells its readers. */
  private set(key: string, value: McpAppRead): void {
    this.values.delete(key)
    this.values.set(key, value)
    for (const listener of this.listeners.get(key) ?? []) listener()
    this.trim()
  }

  /** Drops the oldest values that no reader observes and no read is filling. */
  private trim(): void {
    for (const key of this.values.keys()) {
      if (this.values.size <= KEPT_VALUES) break
      if (!this.listeners.has(key) && !this.reads.has(key)) this.values.delete(key)
    }
  }
}

function keyOf(request: McpAppRequest): string {
  return `${request.sessionId}\0${request.activityId}`
}

const stores = new WeakMap<HostApi, McpAppStore>()

/** The app store of one host's API. */
export function mcpAppsFor(api: HostApi): McpAppStore {
  let store = stores.get(api)
  if (!store) {
    store = new McpAppStore(api)
    stores.set(api, store)
  }
  return store
}
