import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import type { HostConfigPatch, HostConfigSnapshot } from '@solus/contracts/host-config'

/**
 * Host-owned settings this client reads or edits, kept per host id (plans/018
 * §3.1, §3.5): review warming per project path, and the host emitter's own
 * analytics consent. A host never answers for another; the same path string on
 * two hosts is not the same project. No personal value is cached here.
 */
export interface HostSettingsState {
  reviewWarmingByProject: Record<string, boolean>
  /** The host emitter's own consent. */
  analyticsEnabled: boolean
  saving: boolean
  error: string
}

class HostSettingsStore {
  readonly states = new SvelteMap<string, HostSettingsState>()
  /** Bumped by every read, write and event, so an older answer never overwrites a newer one. */
  private readonly revisions = new Map<string, number>()
  private stop: (() => void) | null = null

  /** Once per client: every connected host's settings, kept current. */
  start(): () => void {
    if (this.stop) return this.stop
    const stopEvents = subscribeAllHosts('config.changed', (serverId, snapshot) => {
      this.nextRevision(serverId)
      this.adopt(serverId, snapshot)
    })
    const stopStatus = serverConnections.onStatusChange((serverId, status) => {
      if (status === 'connected') void this.load(serverId)
    })
    for (const serverId of serverConnections.connectedServerIds()) void this.load(serverId)
    this.stop = () => {
      stopEvents()
      stopStatus()
      this.stop = null
    }
    return this.stop
  }

  isReviewWarmingEnabled(serverId: string, projectPath: string): boolean {
    return this.states.get(serverId)?.reviewWarmingByProject[projectPath] === true
  }

  async load(serverId: string): Promise<void> {
    const revision = this.nextRevision(serverId)
    try {
      const snapshot = await serverConnections.apiFor(serverId).configGet()
      if (this.revisions.get(serverId) === revision) this.adopt(serverId, snapshot)
    } catch {
      if (this.revisions.get(serverId) !== revision) return
      const state = this.states.get(serverId)
      if (state) this.states.set(serverId, { ...state, error: 'Could not load this host’s settings.' })
    }
  }

  async setReviewWarmingEnabled(serverId: string, projectPath: string, enabled: boolean): Promise<void> {
    if (!projectPath || projectPath === '~') return
    const state = this.states.get(serverId)
    if (!state) return
    const reviewWarmingByProject = { ...state.reviewWarmingByProject, [projectPath]: enabled }
    await this.write(serverId, { reviewWarmingByProject }, { reviewWarmingByProject })
  }

  /** The host emitter's consent. A client's own analytics choice never reaches it. */
  async setHostAnalyticsEnabled(serverId: string, enabled: boolean): Promise<void> {
    const state = this.states.get(serverId)
    if (!state) return
    await this.write(serverId, { analyticsEnabled: enabled }, { analyticsEnabled: enabled })
  }

  private async write(
    serverId: string,
    patch: HostConfigPatch,
    optimistic: Partial<HostSettingsState>,
  ): Promise<void> {
    const previous = this.states.get(serverId)
    if (!previous || previous.saving) return
    const revision = this.nextRevision(serverId)
    // A small per-host record, replaced whole: one host's change wakes only its readers.
    this.states.set(serverId, { ...previous, ...optimistic, saving: true, error: '' })
    try {
      const snapshot = await serverConnections.apiFor(serverId).configUpdate(patch)
      if (this.revisions.get(serverId) === revision) this.adopt(serverId, snapshot)
    } catch (error) {
      if (this.revisions.get(serverId) !== revision) return
      this.states.set(serverId, { ...previous, saving: false, error: error instanceof Error ? error.message : 'Could not save this host’s settings.' })
    }
  }

  private nextRevision(serverId: string): number {
    const revision = (this.revisions.get(serverId) ?? 0) + 1
    this.revisions.set(serverId, revision)
    return revision
  }

  private adopt(serverId: string, snapshot: HostConfigSnapshot): void {
    this.states.set(serverId, {
      reviewWarmingByProject: { ...snapshot.config.reviewWarmingByProject },
      analyticsEnabled: snapshot.config.analyticsEnabled,
      saving: false,
      error: '',
    })
  }
}

export const hostSettingsStore = new HostSettingsStore()
