import type { DetectedEditor, DetectedTerminal, ResolvedTerminal, TerminalAppId } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'
import type { HostApi } from '@solus/client-core/host-api'
import { SvelteMap } from 'svelte/reactivity'

export interface DetectedTools {
  editors: DetectedEditor[]
  terminals: DetectedTerminal[]
}

function emptyDetectedTools(): DetectedTools {
  return { editors: [], terminals: [] }
}

export class ToolsStore {
  private readonly detectedByHost = new SvelteMap<string, DetectedTools>()
  private readonly loadedHosts = new SvelteMap<string, boolean>()
  private readonly loadingHosts = new SvelteMap<string, boolean>()
  private readonly inFlightByHost = new Map<string, Promise<DetectedTools>>()

  /**
   * The terminal "Open in terminal" would use right now — the one already
   * holding the shared tmux session, or the configured fallback. It changes
   * whenever the user opens or closes a terminal, so surfaces refresh it rather
   * than caching it for the session: `refreshResolvedTerminal` always re-asks.
   */
  resolvedTerminal = $state<ResolvedTerminal | null>(null)

  private resolvedTerminalInFlight: Promise<ResolvedTerminal | null> | null = null

  async refreshResolvedTerminal(fallbackTerminalId: TerminalAppId | null): Promise<ResolvedTerminal | null> {
    if (this.resolvedTerminalInFlight) return this.resolvedTerminalInFlight
    // Terminals only launch on the machine the client runs on; a web client has
    // no local host and so has nothing to resolve.
    const serverId = serverConnections.localServerId()
    const promise = (async () => {
      if (!serverId) return null
      return serverConnections.apiFor(serverId).resolveTerminal(fallbackTerminalId)
    })()
      .then((resolved) => {
        this.resolvedTerminal = resolved
        return resolved
      })
      .catch(() => null)
      .finally(() => {
        if (this.resolvedTerminalInFlight === promise) this.resolvedTerminalInFlight = null
      })
    this.resolvedTerminalInFlight = promise
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
