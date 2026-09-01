import type { Snippet } from 'svelte'
import { SvelteMap } from 'svelte/reactivity'

/**
 * What a pane wants painted **over** its page.
 *
 * A native guest is a `<webview>` mounted in a fixed layer at app root, so it
 * paints above every pane whatever the pane's own z-index says — and a pane
 * cannot escape upward, because `WorkspaceBody` transforms its columns while
 * they animate, which makes `position: fixed` inside a pane relative to the
 * column rather than to the window.
 *
 * A `<webview>` is ordinary DOM, though — that is precisely why Solus uses one
 * rather than a `WebContentsView`, which composites above the DOM entirely — so
 * something rendered *beside* it in the same wrapper paints over it. The load
 * veil already relies on this. This registry is how a pane gets its own chrome
 * into that wrapper: the stage registers a snippet under the page's key, and the
 * layer renders it above the guest, inside the frame.
 *
 * Only native surfaces need it. A streamed canvas is an ordinary element in the
 * stage, so the stage puts its own overlay straight on top.
 */
export class BrowserOverlays {
  /** Keyed by the page's host key. Absent means "nothing to paint over it". The
   *  snippet is handed the frame's scale, so a mark-anchored control positions
   *  itself in the frame's own coordinate space. */
  snippets = new SvelteMap<string, Snippet<[number]>>()
  /** The snippet that currently owns the page's interaction shield. A comment
   *  popup blocks the guest while the user resolves it; ordinary annotation
   *  tools stay click-through so the guest can collect the next mark. */
  blocking = new SvelteMap<string, Snippet<[number]>>()
  #blockingOwners = new Map<string, Snippet<[number]>>()

  set(key: string, snippet: Snippet<[number]>, blocksSurface = false): void {
    this.snippets.set(key, snippet)
    // Do not read the reactive map here. `set` runs inside the stage's effect;
    // subscribing that effect to the key it writes would make the shield toggle
    // invalidate itself forever. The plain owner map is the dedupe guard.
    if (blocksSurface) {
      this.#blockingOwners.set(key, snippet)
      this.blocking.set(key, snippet)
    } else {
      this.#blockingOwners.delete(key)
      this.blocking.delete(key)
    }
  }

  /**
   * Withdraw a snippet, if it is still the one showing.
   *
   * Two stages can show one page — the slot lease exists for exactly that — and
   * the one that loses the guest unmounts after the one that won has registered.
   * An unconditional delete there would take the winner's chrome down with it.
   */
  clear(key: string, snippet: Snippet<[number]>): void {
    if (this.snippets.get(key) !== snippet) return
    this.snippets.delete(key)
    if (this.#blockingOwners.get(key) === snippet) {
      this.#blockingOwners.delete(key)
      this.blocking.delete(key)
    }
  }
}

export const browserOverlays = new BrowserOverlays()
