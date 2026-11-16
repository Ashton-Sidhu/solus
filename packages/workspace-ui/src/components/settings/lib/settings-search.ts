import { settingMatches } from '@solus/client-core/settings-search'
import { settingsDefinitions } from '@solus/client-core/settings-definitions'
import { APP_NOTICE_ROWS, NOTIFICATION_CHANNEL_ROWS, SESSION_EVENT_ROWS } from './notification-settings'
import { settingsByPage } from './settings-search-data'
import { bindingsForScope } from '../../../lib/keybindings/manifest'
import { KEYBINDING_CATEGORIES, effectiveCombo, matchesQuery, type BindingOverrides } from '../../../lib/keybindings/editing'
import { matchingToolGroups } from './solus-tool-groups'

/**
 * Settings search covers every page, not only the open one. A page matches
 * through its display text, row definitions, and optional aliases. A page
 * that matches by its label shows all of its settings.
 */
export function wordsMatch(query: string, words: readonly string[]): boolean {
  return settingMatches(query, { label: words.join(' ') })
}

function rowsForPage(page: string) {
  return Object.entries(settingsByPage).find(([name]) => name === page)?.[1] ?? []
}

// Index only text. Closed pages stay unloaded, and no host data or credentials enter it.
const pageDefinitions = new Map<string, Array<{ label: string; description?: string }>>()
for (const [key, definition] of Object.entries(settingsDefinitions)) {
  const page = key.slice(0, key.indexOf('.'))
  const definitions = pageDefinitions.get(page) ?? []
  definitions.push(definition)
  pageDefinitions.set(page, definitions)
}

export function settingsPageMatches(page: string, query: string): boolean {
  if (page === 'notifications') return [...APP_NOTICE_ROWS, ...NOTIFICATION_CHANNEL_ROWS, ...SESSION_EVENT_ROWS].some((row) => settingMatches(query, row))
  return rowsForPage(page).some((item) => settingMatches(query, item)) ||
    (pageDefinitions.get(page) ?? []).some((item) => settingMatches(query, item))
}

/** A section heading or a nested control opens its page without hiding its rows. */
export function settingsPageQuery(page: string, query: string): string {
  if (page === 'notifications') return query
  if (rowsForPage(page).some((item) => settingMatches(query, item))) return query
  return settingsPageMatches(page, query) ? '' : query
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
