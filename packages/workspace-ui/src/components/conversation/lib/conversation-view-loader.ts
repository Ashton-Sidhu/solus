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
