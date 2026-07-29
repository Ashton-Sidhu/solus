import { SvelteMap } from 'svelte/reactivity'
import type { SavedPrompt } from '../../../shared/types'

/**
 * Renderer-side cache + RPC wrapper for saved prompts, keyed by project root.
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
  forProject(projectRoot: string | null | undefined): SavedPrompt[] {
    if (!projectRoot) return []
    return this.byProjectRoot.get(projectRoot) ?? []
  }

  load(projectRoot: string, opts?: { force?: boolean }): Promise<SavedPrompt[]> {
    if (!projectRoot) return Promise.resolve([])
    const pending = this.inFlight.get(projectRoot)
    if (pending) return pending
    if (!opts?.force && this.byProjectRoot.has(projectRoot)) {
      return Promise.resolve(this.byProjectRoot.get(projectRoot)!)
    }
    const load = (async () => {
      try {
        const list = await window.solus.savedPromptsList(projectRoot)
        this.byProjectRoot.set(projectRoot, list)
        return list
      } catch (err) {
        console.error('saved prompts load failed', err)
        return this.byProjectRoot.get(projectRoot) ?? []
      } finally {
        this.inFlight.delete(projectRoot)
      }
    })()
    this.inFlight.set(projectRoot, load)
    return load
  }

  /**
   * `prompt.attachments` is lifted off the live composer state, so it arrives
   * here as a `$state` proxy — snapshot it or the structured clone across the
   * wire throws.
   */
  async create(prompt: SavedPrompt): Promise<void> {
    const list = await window.solus.savedPromptsCreate($state.snapshot(prompt) as SavedPrompt)
    this.byProjectRoot.set(prompt.projectRoot, list)
  }

  async remove(projectRoot: string, id: string): Promise<void> {
    const list = await window.solus.savedPromptsDelete(projectRoot, id)
    this.byProjectRoot.set(projectRoot, list)
  }
}

export const savedPrompts = new SavedPromptsStore()
