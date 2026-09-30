// Pure, non-reactive helpers for the task composer: the "Create another"
// preference, due-date quick presets, and roving-focus keyboard navigation for the property pickers.
// Kept out of the .svelte file per the renderer guidelines so the component stays
// markup + thin handlers.
const ANOTHER_KEY = 'solus:task-composer-create-another'

/** "Create another" is a sticky preference so rapid-entry users keep it on. */
export function loadCreateAnother(): boolean {
  try {
    return localStorage.getItem(ANOTHER_KEY) === '1'
  } catch {
    return false
  }
}

export function saveCreateAnother(on: boolean): void {
  try {
    localStorage.setItem(ANOTHER_KEY, on ? '1' : '0')
  } catch {
    // ignore
  }
}

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface DuePreset {
  label: string
  iso: string
}

/** Linear-style quick due-date options, relative to today. */
export function dueDatePresets(): DuePreset[] {
  const today = new Date()
  const tomorrow = new Date(today)
  tomorrow.setDate(today.getDate() + 1)
  // Upcoming Saturday (today if it already is one).
  const weekend = new Date(today)
  weekend.setDate(today.getDate() + ((6 - today.getDay() + 7) % 7))
  const nextWeek = new Date(today)
  nextWeek.setDate(today.getDate() + 7)
  return [
    { label: 'Today', iso: isoDay(today) },
    { label: 'Tomorrow', iso: isoDay(tomorrow) },
    { label: 'This weekend', iso: isoDay(weekend) },
    { label: 'Next week', iso: isoDay(nextWeek) },
  ]
}

/** Arrow-key roving focus between the option buttons inside an open picker
 *  popover. Options are tagged with [data-pick-item]; focus wraps at both ends. */
export function pickerKeydown(e: KeyboardEvent, container: HTMLElement | null): void {
  if (!container || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
  const items = Array.from(container.querySelectorAll<HTMLElement>('[data-pick-item]'))
  if (!items.length) return
  e.preventDefault()
  const idx = document.activeElement instanceof HTMLElement
    ? items.indexOf(document.activeElement)
    : -1
  const dir = e.key === 'ArrowDown' ? 1 : -1
  const next = items[(idx + dir + items.length) % items.length] ?? items[0]
  next.focus()
}

/** On open, land focus on the selected option (or the first) so the picker is
 *  immediately keyboard-drivable. */
export function focusFirstItem(container: HTMLElement | null): void {
  if (!container) return
  const target =
    container.querySelector<HTMLElement>('[data-pick-item][data-selected="true"]') ??
    container.querySelector<HTMLElement>('[data-pick-item]')
  target?.focus()
}

/** Normalize a free-typed label and reject blanks/dupes (case-insensitive). */
export function addLabel(labels: string[], raw: string): string[] {
  const label = raw.trim()
  if (!label) return labels
  if (labels.some((l) => l.toLowerCase() === label.toLowerCase())) return labels
  return [...labels, label]
}

/** Suggestions = known project labels not already chosen, filtered by the typed
 *  query. Capped so the popover never runs away. */
export function labelSuggestions(known: string[], selected: string[], query: string): string[] {
  const q = query.trim().toLowerCase()
  const chosen = new Set(selected.map((l) => l.toLowerCase()))
  return known
    .filter((l) => !chosen.has(l.toLowerCase()) && (!q || l.toLowerCase().includes(q)))
    .slice(0, 8)
}
