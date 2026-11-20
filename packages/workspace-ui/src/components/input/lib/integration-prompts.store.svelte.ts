import { SvelteMap } from 'svelte/reactivity'
import type { IntegrationPrompt, IntegrationPromptGetRequest, IntegrationPromptSignIn, IntegrationPromptText } from '@solus/contracts/integrations/prompts'
import { serverConnections } from '@solus/client-core/server-connections'
import { onServerRemoving } from '@solus/client-core/server-registry'

/**
 * The MCP prompts of each host and project (docs/plans/mcp-first-class.md §10)
 * for the slash menu. A list is read when a composer opens the `/` menu and
 * kept: the menu shows the kept list at once and never waits on the network,
 * and a read happens once per opening, not per keystroke. `integration.changed`
 * (a server's list changed, a server was added or removed) and a reconnect
 * read the kept lists of that host again; the old list shows until the new
 * one lands.
 */

export interface PromptListState {
  /** `loading`: the first read runs. `error`: it failed, or the host is older than MCP prompts; the next opening reads again. */
  status: 'loading' | 'loaded' | 'error'
  prompts: IntegrationPrompt[]
  signIn: IntegrationPromptSignIn[]
  /** A read runs while an older list shows. */
  isRefreshing: boolean
}

const EMPTY: PromptListState = { status: 'loading', prompts: [], signIn: [], isRefreshing: false }

function listKey(serverId: string, projectPath: string | undefined): string {
  return `${serverId}\u0000${projectPath ?? ''}`
}

class IntegrationPromptsStore {
  lists = new SvelteMap<string, PromptListState>()
  /** Per list: bumped by every read, so an older answer does not land. */
  private reads = new Map<string, number>()
  /** Per host: the lists that were read there, with their project. */
  private hostLists = new Map<string, Map<string, string | undefined>>()
  private watches = new Map<string, () => void>()
  private stopRemoving: (() => void) | null = null

  /** The kept list; an empty `loading` state before the first read. */
  stateFor(serverId: string, projectPath: string | undefined): PromptListState {
    return this.lists.get(listKey(serverId, projectPath)) ?? EMPTY
  }

  /** Reads the list when it was never read; a kept list stays fresh through events. */
  ensure(serverId: string, projectPath: string | undefined): void {
    const key = listKey(serverId, projectPath)
    const state = this.lists.get(key)
    if (state && state.status !== 'error') return
    void this.load(serverId, projectPath)
  }

  async load(serverId: string, projectPath: string | undefined): Promise<void> {
    const key = listKey(serverId, projectPath)
    this.watch(serverId)
    let lists = this.hostLists.get(serverId)
    if (!lists) this.hostLists.set(serverId, (lists = new Map()))
    lists.set(key, projectPath)
    const read = (this.reads.get(key) ?? 0) + 1
    this.reads.set(key, read)
    const kept = this.lists.get(key)
    this.lists.set(key, kept ? { ...kept, isRefreshing: true } : { ...EMPTY })
    try {
      const answer = await serverConnections.apiFor(serverId).integrationPromptList(projectPath ? { projectPath } : {})
      if (this.reads.get(key) !== read) return
      this.lists.set(key, { status: 'loaded', prompts: answer.prompts, signIn: answer.signIn, isRefreshing: false })
    } catch {
      if (this.reads.get(key) !== read) return
      const current = this.lists.get(key) ?? { ...EMPTY }
      // A failed refresh keeps the list it had: the menu shows it, and the next event reads again.
      this.lists.set(key, current.status === 'loaded'
        ? { ...current, isRefreshing: false }
        : { ...current, status: 'error', isRefreshing: false })
    }
  }

  /** Expands one prompt on its host. The text is the person's next message. */
  expand(serverId: string, request: IntegrationPromptGetRequest): Promise<IntegrationPromptText> {
    return serverConnections.apiFor(serverId).integrationPromptGet(request)
  }

  private reloadHost(serverId: string): void {
    for (const projectPath of this.hostLists.get(serverId)?.values() ?? []) void this.load(serverId, projectPath)
  }

  private watch(serverId: string): void {
    if (this.watches.has(serverId)) return
    if (this.watches.size === 0) this.stopRemoving ??= onServerRemoving((server) => this.forget(server.id))
    const events = serverConnections.eventsFor(serverId)
    const stopChanged = events.subscribe('integration.changed', () => this.reloadHost(serverId))
    // A sign-in or a sign-out changes which prompts the person sees.
    const stopConnection = events.subscribe('integration.connectionChanged', () => this.reloadHost(serverId))
    const stopReadiness = serverConnections.onReadinessChange((hostId, status) => {
      if (hostId === serverId && status === 'ready') this.reloadHost(serverId)
    })
    this.watches.set(serverId, () => { stopChanged(); stopConnection(); stopReadiness() })
  }

  /** A removed host's lists and watches go. */
  private forget(serverId: string): void {
    this.watches.get(serverId)?.()
    this.watches.delete(serverId)
    for (const key of this.hostLists.get(serverId)?.keys() ?? []) {
      this.lists.delete(key)
      this.reads.delete(key)
    }
    this.hostLists.delete(serverId)
  }
}

export const integrationPromptsStore = new IntegrationPromptsStore()
