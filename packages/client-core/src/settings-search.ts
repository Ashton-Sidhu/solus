/** Text that a settings row displays. State-dependent descriptions can override it. */
export interface SettingCopy {
  label: string
  description?: string
}

export interface SearchableSetting extends SettingCopy {
  keywords?: readonly string[]
}

/** All query terms must occur in the displayed text or in an optional alias. */
export function settingMatches(query: string, setting: SearchableSetting): boolean {
  const text = [setting.label, setting.description ?? '', ...(setting.keywords ?? [])].join(' ').toLowerCase()
  return query.trim().toLowerCase().split(/\s+/).every((term) => text.includes(term))
}

/** A missing definition is an error, rather than a row that silently vanishes. */
export function settingVisible(query: string, items: readonly (SearchableSetting & { id: string })[], settingId: string): boolean {
  const item = items.find((candidate) => candidate.id === settingId)
  if (!item) throw new Error(`Missing setting definition: ${settingId}`)
  return settingMatches(query, item)
}
