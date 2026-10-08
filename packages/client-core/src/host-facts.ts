import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import type {
  AgentUsageLimits,
  DetectedEditor,
  DetectedTerminal,
  HostCapabilities,
  StartInfo,
  VoiceModelStatus,
} from '@solus/contracts/types'
import type { HostApi } from './host-api'
import type { HostEventSubscriber } from './host-event-subscriber'
import { normalizeHostCapabilities } from './host-capabilities'

/** One host fact: not read yet, read, or failed. A fact that has not loaded is
 *  never a guessed value (docs/plans/host-model.md §3.2). */
export type HostFact<T> =
  | { state: 'loading' }
  | { state: 'ready'; value: T }
  | { state: 'error'; message: string }

export interface DetectedTools {
  editors: DetectedEditor[]
  terminals: DetectedTerminal[]
}

export interface HostFactValues {
  /** What the host can do and has, for this caller. Loaded on every new server session. */
  capabilities: HostCapabilities
  /** Identity, roles, and access settings (`connectionsGetServerInfo`). */
  serverInfo: ConnectionsServerInfo
  /** The machine's startup facts (`start()`): version, agent account, paths, agents. */
  machine: StartInfo
  /** Subscription quota of the host's agent logins. */
  usage: AgentUsageLimits[]
  voiceModel: VoiceModelStatus
  /** Editors and terminals the host found, limited to the editors it advertises. */
  tools: DetectedTools
}

export type HostFactKey = keyof HostFactValues

/** How a server session changed, as the connection's supervisor reports it.
 *  `fresh` is a new server session; `recovered` continues the old one; `lost`
 *  is a drop, a failed dial, or a block. */
export type HostSessionChange = 'fresh' | 'recovered' | 'lost'

export interface HostFactsSource {
  readonly api: HostApi
  readonly events: HostEventSubscriber
}

const LOADING: HostFact<never> = { state: 'loading' }
/** Facts a dropped connection clears: an absent record hides actions; it never
 *  shows the last host's answer as current. The others keep their last value. */
const SESSION_FACTS: readonly HostFactKey[] = ['capabilities', 'serverInfo']

type AnyFact = HostFact<HostFactValues[HostFactKey]>

/**
 * Everything the client knows about one host, loaded once and shared by every
 * reader. Plain TypeScript so desktop, web, and mobile build it from their own
 * connection layer; each client adds only its own reactivity on `subscribe`.
 */
export class HostFacts {
  private readonly facts = new Map<HostFactKey, AnyFact>()
  /** Facts some reader asked for; only these reload after a reset. */
  private readonly requested = new Set<HostFactKey>(['capabilities'])
  private readonly inFlight = new Map<HostFactKey, Promise<void>>()
  private readonly readAt = new Map<HostFactKey, number>()
  private readonly listeners = new Set<(key: HostFactKey) => void>()
  private readonly stopEvents: Array<() => void>
  /** Bumps on every session change; a load from an older session never writes. */
  private generation = 0
  private disposed = false

  constructor(
    readonly serverId: string,
    private readonly source: HostFactsSource,
    private readonly now: () => number = Date.now,
  ) {
    this.stopEvents = [
      source.events.subscribe('usage.limitsChanged', ({ snapshots }) => this.set('usage', snapshots)),
      source.events.subscribe('voice.modelStatusChanged', (status) => this.set('voiceModel', status)),
    ]
  }

  get<K extends HostFactKey>(key: K): HostFact<HostFactValues[K]> {
    // SAFETY: `write` and `read` store each key's fact with that key's value type.
    return (this.facts.get(key) ?? LOADING) as HostFact<HostFactValues[K]>
  }

  /** The value when the fact is ready, else undefined. */
  value<K extends HostFactKey>(key: K): HostFactValues[K] | undefined {
    const fact = this.get(key)
    return fact.state === 'ready' ? fact.value : undefined
  }

  /** Start loading a fact that nobody has asked for yet. Idempotent. */
  ensure(key: HostFactKey): void {
    if (this.disposed) return
    this.requested.add(key)
    if (this.get(key).state === 'loading' && !this.inFlight.has(key)) void this.load(key)
  }

  /** Read the fact again. With `maxAgeMs`, a fact read more recently stays. */
  async refresh(key: HostFactKey, opts: { maxAgeMs?: number } = {}): Promise<void> {
    if (this.disposed) return
    this.requested.add(key)
    const readAt = this.readAt.get(key)
    if (opts.maxAgeMs !== undefined && readAt !== undefined && this.now() - readAt < opts.maxAgeMs) return
    const pending = this.inFlight.get(key)
    if (pending) return pending
    return this.load(key)
  }

  /** The fact once it is ready. A failed fact is read once more before this
   *  rejects, so a caller that waits is never refused by an old failure.
   *  Capabilities never fail: an unreadable record is empty ("unsupported"). */
  async when<K extends HostFactKey>(key: K): Promise<HostFactValues[K]> {
    this.ensure(key)
    let retried = false
    for (;;) {
      if (this.disposed) throw new Error('Host facts were disposed')
      // A read in flight is newer than what is held (a fresh session reloads).
      const pending = this.inFlight.get(key)
      if (pending) {
        await pending
        continue
      }
      const fact = this.get(key)
      if (fact.state === 'ready') return fact.value
      if (fact.state === 'error') {
        if (retried) throw new Error(fact.message)
        retried = true
      }
      await this.load(key)
    }
  }

  /** Write an answer the host pushed or a mutation returned. */
  set<K extends HostFactKey>(key: K, value: HostFactValues[K]): void {
    if (this.disposed) return
    this.readAt.set(key, this.now())
    this.write(key, { state: 'ready', value })
  }

  /** The supervisor's report of a server-session edge. */
  sessionChanged(change: HostSessionChange): void {
    if (this.disposed) return
    if (change === 'recovered') {
      for (const key of this.requested) {
        if (this.get(key).state !== 'ready' && !this.inFlight.has(key)) void this.load(key)
      }
      return
    }
    this.generation += 1
    this.inFlight.clear()
    if (change === 'lost') {
      for (const key of SESSION_FACTS) {
        this.readAt.delete(key)
        this.write(key, LOADING)
      }
      return
    }
    // A fresh session may be a restarted host: everything read before is suspect.
    this.readAt.clear()
    for (const key of this.requested) void this.load(key)
  }

  subscribe(listener: (key: HostFactKey) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const stop of this.stopEvents) stop()
    this.listeners.clear()
    this.inFlight.clear()
  }

  private load(key: HostFactKey): Promise<void> {
    const generation = this.generation
    const promise = this.read(key)
      .then((fact) => {
        if (this.disposed || generation !== this.generation) return
        // A failed read never holds the next one back.
        if (fact.state === 'ready') this.readAt.set(key, this.now())
        else this.readAt.delete(key)
        this.write(key, fact)
      })
      .finally(() => {
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key)
      })
    this.inFlight.set(key, promise)
    return promise
  }

  private async read(key: HostFactKey): Promise<AnyFact> {
    const { api } = this.source
    try {
      switch (key) {
        case 'capabilities':
          // An older host rejects the method; that is an empty record, never a feature error.
          return { state: 'ready', value: normalizeHostCapabilities(await api.serverGetCapabilities().catch(() => ({}))) }
        case 'serverInfo':
          return { state: 'ready', value: await api.connectionsGetServerInfo() }
        case 'machine':
          return { state: 'ready', value: await api.start() }
        case 'usage':
          return { state: 'ready', value: await api.usageLimits() }
        case 'voiceModel': {
          const capabilities = await this.when('capabilities')
          // Only the desktop main process transcribes; a server without it never will.
          if (capabilities.voiceModel !== true) return { state: 'error', message: 'Voice model is not supported on this host.' }
          return { state: 'ready', value: await api.voiceModelStatus() }
        }
        case 'tools': {
          const capabilities = await this.when('capabilities')
          if (capabilities.editors === undefined) return { state: 'ready', value: { editors: [], terminals: [] } }
          const result = await api.detectEditors()
          return {
            state: 'ready',
            value: {
              editors: result.editors.filter((editor) => capabilities.editors?.includes(editor.id)),
              terminals: result.terminals,
            },
          }
        }
      }
    } catch (error) {
      if (key === 'tools') return { state: 'ready', value: { editors: [], terminals: [] } }
      return { state: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }

  private write(key: HostFactKey, fact: AnyFact): void {
    this.facts.set(key, fact)
    for (const listener of Array.from(this.listeners)) listener(key)
  }
}
