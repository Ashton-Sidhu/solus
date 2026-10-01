import type { HostConfig, HostConfigPatch } from '@solus/contracts/host-config'
import { SvelteMap } from 'svelte/reactivity'
import { serverConnections } from '@solus/client-core/server-connections'

/** The lead settings the execution host reads when it builds a lead's task
 *  packet. They live on each host, so the Tasks tab edits the selected one. */
export type TaskLeadSettings = Pick<HostConfig, 'leadInstructions' | 'workerModel'>

type TaskLeadSettingsPatch = Pick<HostConfigPatch, 'leadInstructions' | 'workerModel'>

interface TaskLeadSettingsState {
  /** Null until the host answers, and on a host too old to have them. */
  settings: TaskLeadSettings | null
  saving: boolean
  error: string
}

function leadSettingsOf(config: HostConfig): TaskLeadSettings | null {
  // A host older than these settings sends neither key.
  if (!('leadInstructions' in config)) return null
  return { leadInstructions: config.leadInstructions, workerModel: config.workerModel ?? null }
}

const OUTDATED_HOST = 'Update this host to configure task leads.'

export class TaskLeadSettingsStore {
  states = new SvelteMap<string, TaskLeadSettingsState>()
  private watches = new Map<string, { count: number; stop: () => void }>()
  /** Bumped by every read, save and host event, so an older answer never
   *  overwrites a newer one. */
  private revisions = new Map<string, number>()

  watch(serverId: string): () => void {
    let watch = this.watches.get(serverId)
    if (!watch) {
      const stopConfig = serverConnections.eventsFor(serverId).subscribe('config.changed', ({ config }) => {
        this.nextRevision(serverId)
        this.adopt(serverId, config)
      })
      const stopStatus = serverConnections.onStatusChange((hostId, status) => {
        if (hostId !== serverId) return
        if (status === 'connected') {
          void this.load(serverId)
          return
        }
        this.nextRevision(serverId)
        this.states.set(serverId, { settings: null, saving: false, error: 'Host disconnected.' })
      })
      watch = { count: 0, stop: () => { stopConfig(); stopStatus() } }
      this.watches.set(serverId, watch)
      void this.load(serverId)
    }
    watch.count++
    return () => { if (--watch.count === 0) { watch.stop(); this.watches.delete(serverId) } }
  }

  async load(serverId: string): Promise<void> {
    const revision = this.nextRevision(serverId)
    try {
      const { config } = await serverConnections.apiFor(serverId).configGet()
      if (this.revisions.get(serverId) === revision) this.adopt(serverId, config)
    } catch {
      if (this.revisions.get(serverId) !== revision) return
      this.states.set(serverId, { settings: null, saving: false, error: 'Could not load task lead settings.' })
    }
  }

  async save(serverId: string, patch: TaskLeadSettingsPatch): Promise<void> {
    const previous = this.states.get(serverId)?.settings
    if (!previous) return
    const revision = this.nextRevision(serverId)
    // Optimistic, so a chip or switch moves when it is pressed.
    this.states.set(serverId, { settings: { ...previous, ...patch }, saving: true, error: '' })
    try {
      const { config } = await serverConnections.apiFor(serverId).configUpdate(patch)
      if (this.revisions.get(serverId) === revision) this.adopt(serverId, config)
    } catch {
      if (this.revisions.get(serverId) !== revision) return
      this.states.set(serverId, { settings: previous, saving: false, error: 'Could not save task lead settings.' })
    }
  }

  private nextRevision(serverId: string): number {
    const revision = (this.revisions.get(serverId) ?? 0) + 1
    this.revisions.set(serverId, revision)
    return revision
  }

  private adopt(serverId: string, config: HostConfig): void {
    const settings = leadSettingsOf(config)
    this.states.set(serverId, { settings, saving: false, error: settings ? '' : OUTDATED_HOST })
  }
}

export const taskLeadSettingsStore = new TaskLeadSettingsStore()
