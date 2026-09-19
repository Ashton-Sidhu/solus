import type { TypeSafeKeyStatus } from '@solus/contracts/host-config'
import type { SolusToolPreferences } from '@solus/contracts/agent-tools'
import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'

interface SolusToolsState {
  typeSafe?: TypeSafeKeyStatus
  preferences: SolusToolPreferences | null
  saving: boolean
  error: string
  revision: number
}

class SolusToolsStore {
  states = new SvelteMap<string, SolusToolsState>()
  private watches = new Map<string, { count: number; stop: () => void }>()

  watch(serverId: string): () => void {
    let watch = this.watches.get(serverId)
    if (!watch) {
      const stopConfig = serverConnections.eventsFor(serverId).subscribe('config.changed', ({ config, typeSafe }) => {
        const state = this.states.get(serverId)
        this.states.set(serverId, { typeSafe, preferences: config.solusTools ?? null, saving: state?.saving ?? false, error: config.solusTools ? '' : 'Update or restart this host to configure Solus tools.', revision: (state?.revision ?? 0) + 1 })
      })
      const stopStatus = serverConnections.onStatusChange((hostId, status) => {
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
    const state = this.states.get(serverId) ?? { preferences: null, saving: false, error: '', revision: 0 }
    this.states.set(serverId, state)
    const revision = state.revision
    try {
      const { config, typeSafe } = await serverConnections.apiFor(serverId).configGet()
      if (this.states.get(serverId)?.revision !== revision) return
      this.states.set(serverId, { ...state, typeSafe, preferences: config.solusTools ?? null, error: config.solusTools ? '' : 'Update or restart this host to configure Solus tools.', revision: revision + 1 })
    } catch {
      if (this.states.get(serverId)?.revision !== revision) return
      this.states.set(serverId, { ...state, error: 'Could not load Solus tools.' })
    }
  }

  async saveKey(serverId: string, apiKey: string | null): Promise<boolean> {
    const state = this.states.get(serverId)
    if (!state?.typeSafe || state.saving || state.error) return false
    this.states.set(serverId, { ...state, saving: true, revision: state.revision + 1 })
    try {
      const snapshot = await serverConnections.apiFor(serverId).typeSafeKeySet(apiKey)
      const current = this.states.get(serverId)!
      this.states.set(serverId, { ...current,
        typeSafe: current.revision === state.revision + 1 ? snapshot.typeSafe : current.typeSafe,
        saving: false })
      return true
    } catch {
      const current = this.states.get(serverId)!
      this.states.set(serverId, { ...current, saving: false, error: 'Could not save the TypeSafe API key.' })
      return false
    }
  }

  async save(serverId: string, patch: SolusToolPreferences): Promise<void> {
    const state = this.states.get(serverId)
    if (!state || !state.preferences || state.saving || state.error) return
    this.states.set(serverId, { ...state, saving: true, error: '', revision: state.revision + 1 })
    try {
      const { config } = await serverConnections.apiFor(serverId).configUpdate({ solusTools: patch })
      const current = this.states.get(serverId)!
      this.states.set(serverId, { ...current, preferences: current.revision === state.revision + 1 ? config.solusTools : current.preferences, saving: false })
    } catch {
      const current = this.states.get(serverId)!
      this.states.set(serverId, { ...current, saving: false, error: 'Could not save Solus tools.' })
    }
  }
}

export const solusToolsStore = new SolusToolsStore()
