import { mergeHostConfig, type HostConfig, type HostConfigPatch } from '@solus/contracts/host-config'
import { Listeners } from '../../lib/listeners'
import type { HostConnection } from '../hosts/host-connections'

/**
 * One host's own settings: the machine's, which every device using the host
 * shares (plans/018 §3.1). The person's settings live in the personal store and
 * never go to a host; `HostConfigPatch` names only host keys, and the host
 * refuses any other.
 */

export type HostSettingsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; settings: HostConfig }
  | { kind: 'error'; message: string }

const IDLE = { kind: 'idle' } as const

export class HostSettings {
  readonly changes = new Listeners()
  private readonly states = new Map<string, HostSettingsState>()
  /** One `config.changed` subscription per host connection. */
  private readonly watches = new Map<string, { connection: HostConnection; stop: () => void }>()

  constructor(private readonly connectionFor: (hostId: string) => HostConnection | null) {}

  stateOf = (hostId: string): HostSettingsState => this.states.get(hostId) ?? IDLE

  async load(hostId: string): Promise<void> {
    const connection = this.connectionFor(hostId)
    if (!connection) {
      this.set(hostId, { kind: 'error', message: 'This host cannot be reached now.' })
      return
    }
    this.watch(hostId, connection)
    if (this.stateOf(hostId).kind !== 'loaded') this.set(hostId, { kind: 'loading' })
    try {
      const snapshot = await connection.api.configGet()
      if (this.connectionFor(hostId) !== connection) return
      this.set(hostId, { kind: 'loaded', settings: snapshot.config })
    } catch (error) {
      if (this.connectionFor(hostId) !== connection) return
      this.set(hostId, { kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Shows the change at once, then keeps the host's answer. A refused change
   * reads the host again rather than restoring a snapshot: a second change
   * may have landed in between, and the host knows what it holds.
   */
  async update(hostId: string, patch: HostConfigPatch): Promise<void> {
    const connection = this.connectionFor(hostId)
    const current = this.stateOf(hostId)
    if (!connection || current.kind !== 'loaded') throw new Error('This host cannot be reached now.')
    this.set(hostId, { kind: 'loaded', settings: mergeHostConfig(current.settings, patch) })
    try {
      this.set(hostId, { kind: 'loaded', settings: (await connection.api.configUpdate(patch)).config })
    } catch (error) {
      await this.load(hostId)
      throw error
    }
  }

  forgetHost(hostId: string): void {
    this.watches.get(hostId)?.stop()
    this.watches.delete(hostId)
    this.states.delete(hostId)
    this.changes.notify()
  }

  private watch(hostId: string, connection: HostConnection): void {
    const existing = this.watches.get(hostId)
    if (existing?.connection === connection) return
    existing?.stop()
    const stop = connection.events.subscribe('config.changed', (snapshot) => {
      this.set(hostId, { kind: 'loaded', settings: snapshot.config })
    })
    this.watches.set(hostId, { connection, stop })
  }

  private set(hostId: string, state: HostSettingsState): void {
    this.states.set(hostId, state)
    this.changes.notify()
  }
}
