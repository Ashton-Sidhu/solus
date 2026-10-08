import type { ConnectionsServerInfo } from '@solus/contracts/host-api'
import type {
  AgentUsageLimits,
  HostCapabilities,
  StartInfo,
  VoiceModelStatus,
} from '@solus/contracts/types'
import type { DetectedTools, HostFact, HostFactKey, HostFactValues, HostFacts } from '@solus/client-core/host-facts'
import type { HostBooleanCapability } from '@solus/client-core/host-capabilities'
import { hostRolesOf, type HostRole } from '@solus/client-core/host-roles'
import { serverConnections } from '@solus/client-core/server-connections'
import { createSubscriber } from 'svelte/reactivity'

const FACT_KEYS: readonly HostFactKey[] = ['capabilities', 'serverInfo', 'machine', 'usage', 'voiceModel', 'tools']

/**
 * The client's reactive view of one host (docs/plans/host-model.md §3.2). It
 * reads its `HostFacts` directly; each fact has its own subscriber, so a change
 * to one invalidates only its readers. Reading a fact asks its host for it; the
 * request runs outside the read, so a `$derived` may read any fact.
 */
export class Host {
  #facts: HostFacts
  #stopFacts: () => void
  readonly #listeners = new Set<(key: HostFactKey) => void>()
  readonly #requested = new Set<HostFactKey>()
  readonly #subscribers = new Map<HostFactKey, () => void>()

  constructor(
    readonly id: string,
    facts: HostFacts,
    /** The roles this client assumes before the host says (a cloud row is collaboration-only). */
    private readonly assumedRoles: () => readonly HostRole[],
  ) {
    this.#facts = facts
    this.#stopFacts = facts.subscribe((key) => this.#emit(key))
    for (const key of FACT_KEYS) {
      this.#subscribers.set(key, createSubscriber((update) => {
        const listener = (changed: HostFactKey) => { if (changed === key) update() }
        this.#listeners.add(listener)
        return () => { this.#listeners.delete(listener) }
      }))
    }
  }

  get capabilities(): HostFact<HostCapabilities> { return this.#read('capabilities') }
  get serverInfo(): HostFact<ConnectionsServerInfo> { return this.#read('serverInfo') }
  get machine(): HostFact<StartInfo> { return this.#read('machine') }
  get usage(): HostFact<AgentUsageLimits[]> { return this.#read('usage') }
  get voiceModel(): HostFact<VoiceModelStatus> { return this.#read('voiceModel') }
  get tools(): HostFact<DetectedTools> { return this.#read('tools') }

  /** The capability record once read; undefined while it loads. */
  get capabilityRecord(): HostCapabilities | undefined {
    const fact = this.capabilities
    return fact.state === 'ready' ? fact.value : undefined
  }

  /** True only when the host says so: an absent key or an unread record hides the action. */
  supports(key: HostBooleanCapability): boolean {
    return this.capabilityRecord?.[key] === true
  }

  /** The desktop main process registered its handlers here (screenshots, design
   *  mode, native dialogs). Assumed until the host says otherwise. */
  get hasDesktopHandlers(): boolean {
    return this.capabilityRecord?.desktopHandlers !== false
  }

  /** The machine's startup facts once read; undefined while they load or failed. */
  get machineInfo(): StartInfo | undefined {
    const fact = this.machine
    return fact.state === 'ready' ? fact.value : undefined
  }

  /** Which planes this host serves: its own answer, else what the client assumes. */
  get roles(): readonly HostRole[] {
    const fact = this.serverInfo
    return hostRolesOf(fact.state === 'ready' ? fact.value : null, this.assumedRoles())
  }

  /** This host transcribes: show the mic while that is still unknown, so it never
   *  flashes out of a composer on a host that has it. */
  get transcribes(): boolean {
    const fact = this.capabilities
    return fact.state !== 'ready' || fact.value.voiceModel === true
  }

  /** The voice model's status as the mic shows it: `checking` until the host
   *  answers, and an error on a host that does not transcribe. */
  get voiceStatus(): VoiceModelStatus {
    const fact = this.voiceModel
    if (fact.state === 'ready') return fact.value
    if (fact.state === 'error') return { state: 'error', error: fact.message }
    return { state: 'checking' }
  }

  get voiceReady(): boolean {
    return this.voiceStatus.state === 'ready'
  }

  /** Download progress, 0–100, while the model downloads; else null. */
  get voiceProgressPct(): number | null {
    const status = this.voiceStatus
    return status.totalBytes && status.receivedBytes !== undefined
      ? Math.max(0, Math.min(100, Math.round(status.receivedBytes / status.totalBytes * 100)))
      : null
  }

  /** Ask the host to download or install its voice model again. */
  async retryVoiceModel(): Promise<void> {
    if (this.capabilityRecord?.voiceModel !== true) return
    this.#facts.set('voiceModel', await serverConnections.apiFor(this.id).voiceModelRetry())
  }

  /** Read a fact again. With `maxAgeMs`, a recent read stays. */
  refresh(key: HostFactKey, opts?: { maxAgeMs?: number }): Promise<void> {
    return this.#facts.refresh(key, opts)
  }

  /** The fact once it is ready (see `HostFacts.when`). */
  when<K extends HostFactKey>(key: K): Promise<HostFactValues[K]> {
    return this.#facts.when(key)
  }

  /** Write an answer a mutation returned, such as a new projects folder. */
  patchCapabilities(patch: Partial<HostCapabilities>): void {
    const current = this.#facts.value('capabilities')
    if (current) this.#facts.set('capabilities', { ...current, ...patch })
  }

  isBoundTo(facts: HostFacts): boolean {
    return this.#facts === facts
  }

  /** The connection was replaced (a new transport for the same host): follow its facts. */
  bind(facts: HostFacts): void {
    if (facts === this.#facts) return
    this.#stopFacts()
    this.#facts = facts
    this.#stopFacts = facts.subscribe((key) => this.#emit(key))
    for (const key of this.#requested) facts.ensure(key)
    for (const key of FACT_KEYS) this.#emit(key)
  }

  #read<K extends HostFactKey>(key: K): HostFact<HostFactValues[K]> {
    this.#subscribers.get(key)?.()
    if (!this.#requested.has(key)) {
      this.#requested.add(key)
      // Asking writes state; a `$derived` that reads a fact must not.
      const facts = this.#facts
      queueMicrotask(() => facts.ensure(key))
    }
    return this.#facts.get(key)
  }

  #emit(key: HostFactKey): void {
    for (const listener of Array.from(this.#listeners)) listener(key)
  }
}
