import type { Integration } from '@solus/contracts/integration-types'
import { IntegrationSignIn } from '@solus/contracts/integrations/integration-sign-in'
import type { IntegrationSetupNeed } from '@solus/contracts/integrations/setup-handoff'
import { SvelteMap } from 'svelte/reactivity'
import { integrationsStore } from '../integrations.store.svelte'
import { probeRefusal, urlHost } from './integration-labels'

/** An Add that runs, or the reason the last one stopped, for one server address. */
export type InstallState =
  | { kind: 'checking' }
  | { kind: 'adding' }
  /** `setupNeed`: the probe refused for a cause an agent can look up (§13.4). */
  | { kind: 'failed'; message: string; setupNeed?: IntegrationSetupNeed }

/** Add on one host: probe, then create. The MCP page and the connect card share it. */
export class McpInstalls {
  /** By server address: an Add that runs or failed. A successful Add leaves no entry. */
  installs = new SvelteMap<string, InstallState>()

  constructor(protected readonly serverId: string) {}

  /** Checks the server from the host and adds it. Null when it stopped; the reason is in `installs`. */
  async install(name: string, url: string): Promise<Integration | null> {
    const running = this.installs.get(url)
    if (running && running.kind !== 'failed') return null
    this.installs.set(url, { kind: 'checking' })
    const attempt = await integrationsStore.probe(this.serverId, url)
    const refusal = 'error' in attempt ? attempt.error : probeRefusal(attempt.result)
    if (refusal) {
      const setupNeed = 'result' in attempt ? IntegrationSignIn.setupNeedOfProbe(attempt.result, url) : null
      this.installs.set(url, setupNeed ? { kind: 'failed', message: refusal, setupNeed } : { kind: 'failed', message: refusal })
      return null
    }
    this.installs.set(url, { kind: 'adding' })
    const integration = await integrationsStore.create(this.serverId, { name: name.trim() || urlHost(url), url })
    if (!integration) {
      const message = integrationsStore.states.get(this.serverId)?.writeError || 'Another change is saving. Try again.'
      integrationsStore.clearWriteError(this.serverId)
      this.installs.set(url, { kind: 'failed', message })
      return null
    }
    this.installs.delete(url)
    return integration
  }

  dismiss(url: string): void {
    if (this.installs.get(url)?.kind === 'failed') this.installs.delete(url)
  }
}
