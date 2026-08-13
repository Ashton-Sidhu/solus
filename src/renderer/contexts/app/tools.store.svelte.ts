import type { DetectedEditor, DetectedTerminal } from '../../../shared/types'
import { serverConnections } from '@client-core/server-connections'
import type { HostApi } from '@client-core/host-api'
import { SvelteMap } from 'svelte/reactivity'

export interface DetectedTools {
  editors: DetectedEditor[]
  terminals: DetectedTerminal[]
}

function emptyDetectedTools(): DetectedTools {
  return { editors: [], terminals: [] }
}

export class ToolsStore {
  // These legacy fields back the compact client-local settings popover. The
  // full Settings tab reads the selected host through detectedFor().
  detectedEditors = $state<DetectedEditor[]>([])
  detectedTerminals = $state<DetectedTerminal[]>([])
  detectedToolsLoaded = $state(false)
  detectedToolsLoading = $state(false)

  private detectedToolsInFlight: Promise<DetectedTools> | null = null
  private readonly detectedByHost = new SvelteMap<string, DetectedTools>()
  private readonly loadedHosts = new SvelteMap<string, boolean>()
  private readonly loadingHosts = new SvelteMap<string, boolean>()
  private readonly inFlightByHost = new Map<string, Promise<DetectedTools>>()

  async loadDetectedTools(opts: { force?: boolean } = {}): Promise<DetectedTools> {
    if (this.detectedToolsLoaded && !opts.force) {
      return { editors: this.detectedEditors, terminals: this.detectedTerminals }
    }
    if (this.detectedToolsInFlight && !opts.force) return this.detectedToolsInFlight

    this.detectedToolsLoading = true
    const serverId = serverConnections.connectionFor()?.serverId
    const promise = (async () => {
      if (!serverId) return emptyDetectedTools()
      const capabilities = await serverConnections.capabilitiesFor(serverId)
      if (capabilities.editors === undefined) {
        return emptyDetectedTools()
      }
      const result = await serverConnections.primaryApi().detectEditors()
      return {
        editors: result.editors.filter((editor) => capabilities.editors?.includes(editor.id)),
        terminals: result.terminals,
      }
    })()
      .then((result) => {
        this.detectedEditors = result.editors
        this.detectedTerminals = result.terminals
        this.detectedToolsLoaded = true
        return result
      })
      .catch(() => {
        const empty = emptyDetectedTools()
        this.detectedEditors = empty.editors
        this.detectedTerminals = empty.terminals
        this.detectedToolsLoaded = true
        return empty
      })
      .finally(() => {
        this.detectedToolsLoading = false
        if (this.detectedToolsInFlight === promise) this.detectedToolsInFlight = null
      })
    this.detectedToolsInFlight = promise
    return promise
  }

  detectedFor(serverId: string): DetectedTools {
    return this.detectedByHost.get(serverId) ?? { editors: [], terminals: [] }
  }

  loadedFor(serverId: string): boolean {
    return this.loadedHosts.get(serverId) === true
  }

  loadingFor(serverId: string): boolean {
    return this.loadingHosts.get(serverId) === true
  }

  async loadDetectedToolsFor(
    serverId: string,
    api: Pick<HostApi, 'detectEditors'>,
    opts: { force?: boolean } = {},
  ): Promise<DetectedTools> {
    const cached = this.detectedByHost.get(serverId)
    if (this.loadedFor(serverId) && !opts.force) return cached ?? { editors: [], terminals: [] }
    const pending = this.inFlightByHost.get(serverId)
    if (pending && !opts.force) return pending

    this.loadingHosts.set(serverId, true)
    const promise = serverConnections.capabilitiesFor(serverId)
      .then(async (capabilities) => {
        if (capabilities.editors === undefined) {
          return emptyDetectedTools()
        }
        const result = await api.detectEditors()
        return {
          editors: result.editors.filter((editor) => capabilities.editors?.includes(editor.id)),
          terminals: result.terminals,
        }
      })
      .then((result) => {
        this.detectedByHost.set(serverId, result)
        this.loadedHosts.set(serverId, true)
        return result
      })
      .catch(() => {
        const empty: DetectedTools = { editors: [], terminals: [] }
        this.detectedByHost.set(serverId, empty)
        this.loadedHosts.set(serverId, true)
        return empty
      })
      .finally(() => {
        this.loadingHosts.set(serverId, false)
        if (this.inFlightByHost.get(serverId) === promise) this.inFlightByHost.delete(serverId)
      })
    this.inFlightByHost.set(serverId, promise)
    return promise
  }
}

export const toolsStore = new ToolsStore()
