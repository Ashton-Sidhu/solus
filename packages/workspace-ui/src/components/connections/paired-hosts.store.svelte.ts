import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import type { PairedHostSummary } from '@solus/contracts/host-api'

interface PairedHostsState {
  hosts: PairedHostSummary[]
  loaded: boolean
  pairing: boolean
  error: string
}

/**
 * The hosts each host paired with, so its agents can start sessions there
 * (docs/plans/cross-host-sessions.md §10). Keyed by the host that holds the
 * pairing; the tokens never reach a client.
 */
class PairedHostsStore {
  states = new SvelteMap<string, PairedHostsState>()
  private loads = new Map<string, number>()

  async load(serverId: string): Promise<void> {
    const state = this.stateFor(serverId)
    const load = (this.loads.get(serverId) ?? 0) + 1
    this.loads.set(serverId, load)
    try {
      const hosts = await serverConnections.apiFor(serverId).pairedHostsList()
      if (this.loads.get(serverId) !== load) return
      state.hosts = hosts
      state.loaded = true
      state.error = ''
    } catch (error) {
      if (this.loads.get(serverId) !== load) return
      state.loaded = true
      state.error = error instanceof Error ? error.message : String(error)
    }
  }

  /** True when the host paired; the error stays on the state otherwise. */
  async pair(serverId: string, url: string, code: string): Promise<boolean> {
    const state = this.stateFor(serverId)
    state.pairing = true
    state.error = ''
    try {
      await serverConnections.apiFor(serverId).pairedHostsPair({ url, code })
      await this.load(serverId)
      return true
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
      return false
    } finally {
      state.pairing = false
    }
  }

  async forget(serverId: string, installationId: string): Promise<void> {
    const state = this.stateFor(serverId)
    try {
      await serverConnections.apiFor(serverId).pairedHostsForget({ installationId })
      await this.load(serverId)
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
    }
  }

  private stateFor(serverId: string): PairedHostsState {
    const existing = this.states.get(serverId)
    if (existing) return existing
    const state = $state<PairedHostsState>({ hosts: [], loaded: false, pairing: false, error: '' })
    this.states.set(serverId, state)
    return state
  }
}

export const pairedHostsStore = new PairedHostsStore()
