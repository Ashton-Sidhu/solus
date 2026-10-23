import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'

/** The host config keys that hold a number of days to keep something. */
type RetentionKey = 'archivedAutomationRetentionDays' | 'unfiledRecordingRetentionDays'

interface RetentionState {
  days: number | null
  saving: boolean
  error: string
  revision: number
}

export class HostRetentionStore {
  states = new SvelteMap<string, RetentionState>()
  private watches = new Map<string, { count: number; stop: () => void }>()

  /** `subject` names what is kept, for errors: "archive retention". */
  constructor(private readonly key: RetentionKey, private readonly subject: string) {}

  watch(serverId: string): () => void {
    let watch = this.watches.get(serverId)
    if (!watch) {
      const stopConfig = serverConnections.eventsFor(serverId).subscribe('config.changed', ({ config }) => {
        const state = this.states.get(serverId)
        this.states.set(serverId, { days: config[this.key], saving: state?.saving ?? false, error: '', revision: (state?.revision ?? 0) + 1 })
      })
      const stopStatus = serverConnections.onPhaseChange((hostId, status) => {
        if (hostId !== serverId) return
        if (status === 'connected') void this.load(serverId)
        else {
          const state = this.states.get(serverId)
          if (state) this.states.set(serverId, { ...state, error: 'Host disconnected.', revision: state.revision + 1 })
        }
      })
      watch = { count: 0, stop: () => { stopConfig(); stopStatus() } }
      this.watches.set(serverId, watch)
      void this.load(serverId)
    }
    watch.count++
    return () => { if (--watch.count === 0) { watch.stop(); this.watches.delete(serverId) } }
  }

  async load(serverId: string): Promise<void> {
    const state = this.states.get(serverId) ?? { days: null, saving: false, error: '', revision: 0 }
    this.states.set(serverId, state)
    const revision = state.revision
    try {
      const { config } = await serverConnections.apiFor(serverId).configGet()
      if (this.states.get(serverId)?.revision !== revision) return
      this.states.set(serverId, { ...state, days: config[this.key], error: '', revision: revision + 1 })
    } catch {
      if (this.states.get(serverId)?.revision !== revision) return
      this.states.set(serverId, { ...state, error: `Could not load ${this.subject}.` })
    }
  }

  async save(serverId: string, days: number): Promise<void> {
    const state = this.states.get(serverId)
    if (!state || state.saving) return
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      this.states.set(serverId, { ...state, error: 'Enter a whole number from 1 to 3650 days.' })
      return
    }
    this.states.set(serverId, { ...state, saving: true, error: '', revision: state.revision + 1 })
    try {
      const { config } = await serverConnections.apiFor(serverId).configUpdate({ [this.key]: days })
      const current = this.states.get(serverId)!
      this.states.set(serverId, { ...current, days: current.revision === state.revision + 1 ? config[this.key] : current.days, saving: false, error: '' })
    } catch {
      const current = this.states.get(serverId)!
      this.states.set(serverId, { ...current, saving: false, error: `Could not save ${this.subject}.` })
    }
  }
}

export const automationRetentionStore = new HostRetentionStore('archivedAutomationRetentionDays', 'archive retention')
export const recordingRetentionStore = new HostRetentionStore('unfiledRecordingRetentionDays', 'recording retention')
