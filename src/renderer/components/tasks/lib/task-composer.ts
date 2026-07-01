// Pure, non-reactive helpers for the task composer: draft persistence, due-date
// quick presets, and roving-focus keyboard navigation for the property pickers.
// Kept out of the .svelte file per the renderer guidelines so the component stays
// markup + thin handlers.
import type { TaskKind, TaskPriority, TaskStatus } from '../../../../shared/task-types'

/** Snapshot of the composer's fields, persisted so a closed-without-saving draft
 *  comes back. Only the plain "new task" case is persisted (no seed / no preset
 *  parent) — a session-seeded composer always starts from its seed.
 *
 *  Drafts live in sessionStorage, not localStorage: a half-written task should
 *  survive closing/reopening the modal (and window reloads) within a run, but
 *  must NOT outlive an app restart — a stale fragment resurrected days later
 *  reads as a bug, not a convenience. */
export interface ComposerDraft {
  title: string
  body: string
  dueDate: string
  priority: TaskPriority | ''
  status: TaskStatus
  kind: TaskKind
  parentId: string
  labels: string[]
}

const DRAFT_KEY = 'solus:task-composer-draft'
const ANOTHER_KEY = 'solus:task-composer-create-another'

/** A draft is only worth restoring (or persisting) when the user actually typed
 *  something — an empty title/body/labels draft is noise. */
function hasContent(d: Pick<ComposerDraft, 'title' | 'body' | 'labels'>): boolean {
  return d.title.trim().length > 0 || d.body.trim().length > 0 || d.labels.length > 0
}

export function loadDraft(): ComposerDraft | null {
  try {
    // Purge legacy drafts: this key used to live in localStorage, which outlived
    // app restarts. Drop any stale entry so an old draft can't resurface.
    localStorage.removeItem(DRAFT_KEY)
    const raw = sessionStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const d = JSON.parse(raw) as Partial<ComposerDraft>
    const draft: ComposerDraft = {
      title: d.title ?? '',
      body: d.body ?? '',
      dueDate: d.dueDate ?? '',
      priority: (d.priority as TaskPriority) ?? '',
      status: (d.status as TaskStatus) ?? 'open',
      kind: d.kind === 'epic' ? 'epic' : 'task',
      parentId: d.parentId ?? '',
      labels: Array.isArray(d.labels) ? d.labels : [],
    }
    return hasContent(draft) ? draft : null
  } catch {
    return null
  }
}

export function saveDraft(d: ComposerDraft): void {
  try {
    // Don't leave an empty husk behind once the user clears their typing.
    if (!hasContent(d)) {
      sessionStorage.removeItem(DRAFT_KEY)
      return
    }
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d))
  } catch {
    // Storage disabled/full — drafts are best-effort, never block composing.
  }
}

export function clearDraft(): void {
  try {
    sessionStorage.removeItem(DRAFT_KEY)
  } catch {
    // ignore
  }
}

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

export interface DuePreset {
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
  const idx = items.indexOf(document.activeElement as HTMLElement)
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
