import { afterPaint } from '../../../lib/after-paint'

type ConversationModule = typeof import('../ConversationView.svelte')

let loaded: ConversationModule | null = null
let pending: Promise<ConversationModule> | null = null

/** A blank workspace needs no transcript renderer. Once loaded, return the module
 * synchronously so restoring an older tab does not flash a loading skeleton. */
export function loadConversationView(): ConversationModule | Promise<ConversationModule> {
  if (loaded) return loaded
  if (!pending) {
    pending = import('../ConversationView.svelte').then((module) => {
      loaded = module
      return module
    }).catch((error) => {
      pending = null
      throw error
    })
  }
  return pending
}

/** Load the renderer once the workspace has painted and the browser is idle,
 *  so the first open of a session does not wait for it. On a remote host its
 *  files cost several round trips after the click. A failed load is asked
 *  again at the open. */
export function preloadConversationView(): void {
  void afterPaint()
    .then(() => new Promise<void>((resolve) => {
      if ('requestIdleCallback' in globalThis) requestIdleCallback(() => resolve(), { timeout: 2_000 })
      else resolve()
    }))
    .then(() => loadConversationView())
    .catch(() => {})
}
