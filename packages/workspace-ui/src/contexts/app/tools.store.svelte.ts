import type { ResolvedTerminal, TerminalAppId } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'
import { hosts } from '../hosts/hosts.svelte'

/** The device's terminal. A host's detected editors and terminals are its
 *  `Host.tools` fact (docs/plans/host-model.md). */
export class ToolsStore {
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
    // no device host and so has nothing to resolve.
    const device = hosts.device
    const promise = (async () => {
      if (!device) return null
      return serverConnections.apiFor(device.id).resolveTerminal(fallbackTerminalId)
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
}

export const toolsStore = new ToolsStore()
