import { createSavedPrompt, deleteSavedPrompt, listSavedPrompts } from '../../prompts/saved-prompts'
import type { SavedPrompt } from '../../../shared/types'
import type { SolusServer } from '../server'

/** Registers the saved-prompts handlers (composer drafts parked for later). */
export function registerSavedPromptsHandlers(server: SolusServer): void {
  server.register('savedPromptsList', (args) => {
    const [projectRoot] = args as [string]
    return listSavedPrompts(projectRoot)
  })

  server.register('savedPromptsCreate', (args) => {
    const [prompt] = args as [SavedPrompt]
    return createSavedPrompt(prompt)
  })

  // projectRoot rides along so the delete can return the correctly scoped list
  // without a second round trip.
  server.register('savedPromptsDelete', (args) => {
    const [projectRoot, id] = args as [string, string]
    return deleteSavedPrompt(projectRoot, id)
  })
}
