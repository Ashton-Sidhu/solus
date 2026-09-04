/** One label as a picker lists it. Colour is the host's, absent for a local
 *  task label. */
export interface LabelOption {
  name: string
  color?: string
}

/**
 * The rows a picker lists: the record's own labels and the candidates, one
 * row per name (names compare case-insensitively), narrowed by the query, in
 * name order. The record's own labels come first so a label the candidate
 * list no longer carries can still be unchecked.
 */
export function labelPickerOptions(
  labels: LabelOption[],
  candidates: LabelOption[],
  query: string,
): LabelOption[] {
  const byName = new Map<string, LabelOption>()
  for (const option of [...labels, ...candidates]) {
    const name = option.name.trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (!byName.has(key)) byName.set(key, { ...option, name })
  }
  const needle = query.trim().toLowerCase()
  return [...byName.values()]
    .filter((option) => !needle || option.name.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Whether the query names a label nobody has yet. */
export function canCreateLabel(
  labels: LabelOption[],
  candidates: LabelOption[],
  query: string,
): boolean {
  const name = query.trim().toLowerCase()
  if (!name) return false
  return ![...labels, ...candidates].some((option) => option.name.trim().toLowerCase() === name)
}

/** The label names after one row is checked or unchecked. Names compare
 *  case-insensitively, so checking "Bug" over an existing "bug" changes nothing
 *  and unchecking it removes the one already there. */
export function toggleLabelName(names: string[], name: string, checked: boolean): string[] {
  const trimmed = name.trim()
  const key = trimmed.toLowerCase()
  const has = names.some((current) => current.toLowerCase() === key)
  if (checked) return has || !trimmed ? names : [...names, trimmed]
  return names.filter((current) => current.toLowerCase() !== key)
}
