import { bindingsForScope } from '../../../lib/keybindings/manifest'
import { KEYBINDING_CATEGORIES, effectiveCombo, matchesQuery, type BindingOverrides } from '../../../lib/keybindings/editing'
import { matchingToolGroups } from './solus-tool-groups'

/**
 * Settings search covers every page, not only the open one. A page matches
 * when the query is part of its label or of one of its search words. A page
 * that matches by its label shows all of its settings.
 */
export function wordsMatch(query: string, words: readonly string[]): boolean {
  const q = query.toLowerCase()
  return words.some((word) => word.toLowerCase().includes(q))
}

/** Pages whose rows come from data, not from a word list. */
export function dataMatches(tab: string, query: string, keybindings: BindingOverrides): boolean {
  if (tab === 'tools') return matchingToolGroups(query).length > 0
  if (tab === 'keybindings') {
    return KEYBINDING_CATEGORIES.some(({ scopes }) =>
      scopes.some((scope) => bindingsForScope(scope).some(([id, def]) => matchesQuery(def, effectiveCombo(id, keybindings), query))))
  }
  return false
}
