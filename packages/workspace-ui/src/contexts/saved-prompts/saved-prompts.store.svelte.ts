import { SvelteMap } from 'svelte/reactivity'
import type { SavedPrompt } from '@solus/contracts/types'
import { hostKey } from '@solus/client-core/host-key'
import { serverConnections } from '@solus/client-core/server-connections'

/**
 * Renderer-side cache + RPC wrapper for saved prompts, keyed by host and project root.
 *
 * Every mutation returns the authoritative list from the server, so there is no
 * push topic: two windows can drift for as long as one of them keeps a stale
 * sheet open, and the composer control refreshes on open and on window-shown to
 * close that window. Delete is idempotent server-side, so a stale click heals
 * itself rather than erroring.
 */
export class SavedPromptsStore {
  private byProjectRoot = new SvelteMap<string, SavedPrompt[]>()
  private inFlight = new Map<string, Promise<SavedPrompt[]>>()

  /** Empty until the project's list has loaded — callers render a count of 0. */
  forProject(projectRoot: string | null | undefined, serverId: string | null | undefined): SavedPrompt[] {
    if (!projectRoot || !serverId) return []
    return this.byProjectRoot.get(hostKey(serverId, projectRoot)) ?? []
  }

  /** `serverId` names the host that owns `projectRoot` — the run's host. */
  load(projectRoot: string, serverId: string, opts?: { force?: boolean }): Promise<SavedPrompt[]> {
    if (!projectRoot || !serverId) return Promise.resolve([])
    const key = hostKey(serverId, projectRoot)
    const pending = this.inFlight.get(key)
    if (pending) return pending
    if (!opts?.force && this.byProjectRoot.has(key)) {
      return Promise.resolve(this.byProjectRoot.get(key)!)
    }
    const load = (async () => {
      try {
        const list = await serverConnections.apiFor(serverId).savedPromptsList(projectRoot)
        this.byProjectRoot.set(key, list)
        return list
      } catch (err) {
        console.error('saved prompts load failed', err)
        return this.byProjectRoot.get(key) ?? []
      } finally {
        this.inFlight.delete(key)
      }
    })()
    this.inFlight.set(key, load)
    return load
  }

  /**
   * `prompt.attachments` is lifted off the live composer state, so it arrives
   * here as a `$state` proxy — snapshot it or the structured clone across the
   * wire throws.
   */
  async create(prompt: SavedPrompt, serverId: string): Promise<void> {
    const list = await serverConnections.apiFor(serverId).savedPromptsCreate($state.snapshot(prompt))
    this.byProjectRoot.set(hostKey(serverId, prompt.projectRoot), list)
  }

  async remove(projectRoot: string, id: string, serverId: string): Promise<void> {
    const list = await serverConnections.apiFor(serverId).savedPromptsDelete(projectRoot, id)
    this.byProjectRoot.set(hostKey(serverId, projectRoot), list)
  }
}

export const savedPrompts = new SavedPromptsStore()
