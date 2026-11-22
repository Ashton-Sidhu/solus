import type { Integration, IntegrationAuthChoice } from '@solus/contracts/integration-types'
import { IntegrationSignIn } from '@solus/contracts/integrations/integration-sign-in'
import { requestAuthOf } from '@solus/contracts/integrations/auth-choice'
import type { IntegrationSetupNeed } from '@solus/contracts/integrations/setup-handoff'
import { SvelteMap } from 'svelte/reactivity'
import { mcpStore } from '../../../contexts/mcp'
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

  /**
   * Checks the server from the host and adds it. Null when it stopped; the
   * reason is in `installs`. An Authentication the person chose
   * (docs/plans/mcp-add-server.md) skips the check here: the host decides.
   */
  async install(name: string, url: string, auth?: IntegrationAuthChoice): Promise<Integration | null> {
    const running = this.installs.get(url)
    if (running && running.kind !== 'failed') return null
    this.installs.set(url, { kind: 'checking' })
    const attempt = !auth || auth.kind === 'automatic' ? await mcpStore.integrations.probe(this.serverId, url) : null
    const refusal = !attempt ? null : 'error' in attempt ? attempt.error : probeRefusal(attempt.result)
    if (attempt && refusal) {
      const setupNeed = 'result' in attempt ? IntegrationSignIn.setupNeedOfProbe(attempt.result, url) : null
      this.installs.set(url, setupNeed ? { kind: 'failed', message: refusal, setupNeed } : { kind: 'failed', message: refusal })
      return null
    }
    this.installs.set(url, { kind: 'adding' })
    const requestAuth = auth && requestAuthOf(auth)
    const integration = await mcpStore.integrations.create(this.serverId, requestAuth ? { name: name.trim() || urlHost(url), url, auth: requestAuth } : { name: name.trim() || urlHost(url), url })
    if (!integration) {
      const message = mcpStore.integrations.states.get(this.serverId)?.writeError || 'Another change is saving. Try again.'
      mcpStore.integrations.clearWriteError(this.serverId)
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
