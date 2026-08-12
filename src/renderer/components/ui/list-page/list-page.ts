/**
 * The shared vocabulary for Solus's two list surfaces — Tasks and Pull requests
 * ("List pages" spec, Part A). Both pages are the same shell over a different
 * dataset, so the row grammar, group grammar and inbox grammar are declared
 * once here and each page only maps its own records into these shapes.
 *
 * Nothing in here renders. The components in this folder do; the pages own the
 * mapping from `Task` / `PullRequestSummary` into these specs.
 */

import type { CaretRightIcon } from 'phosphor-svelte'

/** The two views every list page has: the grouped global list, and the personal inbox. */
export type ListPageView = 'global' | 'inbox'

/** One project in the header's scope switcher. */
export interface ListProjectOption {
  /** Repo root — the scope key, and the path the favicon is looked up under. */
  projectKey: string
  label: string
}

/** Status tints a chip or a lead statistic may carry. `neutral` is the default
 *  ring-only chip; the rest are the four status semantics from index.css. */
export type ListTint = 'neutral' | 'primary' | 'running' | 'success' | 'warning' | 'failure'

export interface ListPerson {
  /** Stable identity — drives the avatar tint, so the same person is the same
   *  colour on every row of both pages. */
  id: string
  /** 1–2 characters. Use `initialsFor` unless the provider gives better. */
  initials: string
  /** Full name / login, for the avatar's tooltip. */
  name?: string
  /** Provider-hosted profile image. Initials remain the load-error fallback. */
  avatarUrl?: string
  /** Branded fallback when a row has no person avatar to show. */
  fallback?: 'solus'
}

export interface ListChipSpec {
  label: string
  /** Omit for the neutral ring-only chip. */
  tint?: ListTint
  /** Branch names and other machine strings set their own face. */
  mono?: boolean
}

/**
 * Slot 4 — a fact the row holds back until it is the row you are on. Zero width
 * at rest, so every other row keeps its full title; it opens on hover, focus or
 * selection and takes its width from the title, which clips if it has to.
 */
export interface ListRevealSpec {
  /** What is drawn — already shortened by the page if it needed to be. */
  label: string
  /** The untruncated value, as the span's native title. */
  title?: string
  /** A fact that reads before it, middot-separated ("stacked on #41"). */
  lead?: string
}

/**
 * Slot 5 — a check outcome, but only the states worth a row's width. Passing is
 * the expected case and gets a glyph; failing is the exception and gets words.
 * `none` reserves the slot without drawing in it, so a result landing later does
 * not shift the row. Pages with no notion of checks omit the field and the slot.
 */
export interface ListChecksSpec {
  state: 'passing' | 'failing' | 'none'
  /** The failing state's words; the passing glyph's tooltip. */
  label: string
}

/** Slot 6 — churn. Colour carries the sign, so size and direction read in one pass. */
export interface ListChurnSpec {
  additions: number
  deletions: number
}

/** Where a row's record lives — the provider it syncs with, or `local` for a
 *  native Solus record. Drives the provider-logo mark before the id. Mirrors
 *  `TaskProviderId` without importing the task model, so PRs (always GitHub)
 *  can reuse the same slot. */
export type ListSourceId = 'github' | 'linear' | 'jira' | 'local'

/** Slot 2a — the provider a row belongs to, rendered as its brand logo. */
export interface ListRowSource {
  id: ListSourceId
  /** The mark's tooltip ("Linear · syncs status and comments"). */
  title: string
}

/** One line of the global list — slots 1–8 of the row anatomy, in order. */
export interface ListRowSpec {
  /** Stable key for `{#each}` and for selection. */
  key: string
  /** Slot 2 — `SOL-412` on Tasks, `#418` on PRs. */
  ident: string
  /** Slot 2a — the provider this row lives in, shown as a small brand logo
   *  before the id. Omit to hide the slot entirely (e.g. PRs). */
  source?: ListRowSource
  /** Slot 3 — the only full-strength text in the row. */
  title: string
  /** Slot 4 — 0–2 chips: the domain first, then a state that needs colour. */
  chips: ListChipSpec[]
  /** Slot 4 — the hover-revealed fact, in place of a chip that would spend the
   *  same width on every row of the list. */
  reveal?: ListRevealSpec
  /** Slot 5 — the check outcome. Omit on pages that have no checks. */
  checks?: ListChecksSpec
  /** Slot 6 — the page's one sentence of machine state (agent activity / diff size). */
  meta: string
  /** Slot 6 — churn, drawn as two coloured numbers in place of `meta`. */
  churn?: ListChurnSpec
  /** Slots 1 and 7 — the lead is the assignee (Tasks) or author (PRs); the rest
   *  are the remaining participants, capped at 3 with a `+n` tile. */
  people: ListPerson[]
  /** Slot 8 — relative, never absolute. */
  time: string
  /** Absolute timestamp for the time slot's tooltip. */
  timeTitle?: string
}

export interface ListGroupSpec {
  key: string
  label: string
  rows: ListRowSpec[]
}

/** One line of the inbox — two lines of text, and a right end that swaps
 *  metadata for verbs on hover or selection. */
export interface InboxRowSpec {
  key: string
  ident: string
  title: string
  /** Second line: why this is on your list. */
  context: string
  /** Who caused it. */
  actor: ListPerson
  time: string
  timeTitle?: string
  /** Drives title weight and colour. No dot, no fill. */
  unread: boolean
  /** The one verb that clears this row. Omit for rows that are only news. */
  primary?: { label: string; shortcut?: string; run: () => void }
  /** The escape hatch beside it (Snooze, View log). */
  secondary?: { label: string; run: () => void }
  /** Chips shown at rest, in place of the verbs. */
  chips?: ListChipSpec[]
}

export interface InboxGroupSpec {
  key: string
  label: string
  /** Right-aligned note in place of a bare rule ("oldest first"). */
  note?: string
  /** "Needs you" only — takes the brand label colour, and its rows get the
   *  filled primary button rather than the cool one. */
  accent?: boolean
  rows: InboxRowSpec[]
}

/** A statistic in the title block's summary line. The first one is the lead and
 *  is the only coloured text in the header. */
export interface ListSummaryStat {
  label: string
  tint?: ListTint
}

/** Phosphor icon components, as used for the filter-chip glyphs. Typed off a
 *  real icon (the package has no exported props type) — the same pattern
 *  `pr-utils` uses for its status badges. */
export type ListIcon = typeof CaretRightIcon

export interface ListFilterSpec {
  key: string
  label: string
  icon?: ListIcon
  /** Shown while the filter is off; hidden once it's on, because the number is
   *  then the list itself. */
  count?: number
  active: boolean
  toggle: () => void
}

/**
 * One lifecycle state a list can be filtered to. `value` is the page's own
 * status key — a task's `done`, a PR's `merged` — so the menu never has to know
 * what a status *means*, only how many rows carry it.
 */
export interface ListStatusOption {
  value: string
  label: string
  count: number
}

/** Resolve one controlled checkbox change into the ordered status selection.
 *  The checkbox supplies its next state so the menu does not toggle the same
 *  value once locally and once again in the page that owns the filter. */
export function updateListStatusSelection(
  options: readonly ListStatusOption[],
  selected: readonly string[],
  value: string,
  checked: boolean,
): string[] {
  const next = new Set(selected)
  if (checked) next.add(value)
  else next.delete(value)
  return options.map((option) => option.value).filter((status) => next.has(status))
}

/**
 * The 32px time slot. Two characters of number and one of unit, so the column
 * stays a column — "12m", "3h", "5d", "2w". Anything older than a year is "1y+"
 * rather than a date, because the slot is a *relative* age; the exact instant
 * belongs in the tooltip (`absoluteTime`).
 */
export function compactRelativeTime(at: number | string | undefined, now: number): string {
  const ms = typeof at === 'number' ? at : at ? Date.parse(at) : NaN
  if (!Number.isFinite(ms)) return ''
  const seconds = Math.max(0, Math.round((now - ms) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.round(days / 7)
  if (weeks < 52) return `${weeks}w`
  return '1y+'
}

/**
 * A count in the width of a slot: `806`, `1.2k`. Past a thousand the exact
 * figure is not what the number is being read for, and one enormous PR must not
 * be able to push the churn column wide for every row under it.
 */
export function compactCount(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${value}`
}

/** The timestamp the time slot's tooltip carries. */
export function absoluteTime(at: number | string | undefined): string | undefined {
  const ms = typeof at === 'number' ? at : at ? Date.parse(at) : NaN
  if (!Number.isFinite(ms)) return undefined
  return new Date(ms).toLocaleString()
}

const AVATAR_TINTS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'] as const

/**
 * Stable per-person colour. A hash rather than a rotating index so a person
 * keeps their colour as the list is filtered, sorted, and paged — an index
 * would repaint every avatar the moment a row above them dropped out.
 */
export function avatarTint(personId: string): string {
  let hash = 0
  for (let i = 0; i < personId.length; i++) {
    hash = (hash * 31 + personId.charCodeAt(i)) | 0
  }
  return AVATAR_TINTS[Math.abs(hash) % AVATAR_TINTS.length]
}

/**
 * Up to two characters for an avatar. Handles the three shapes providers
 * actually return: a display name ("Priya Kapoor" → PK), a login
 * ("ashton-sidhu" → AS), and a single word ("maya" → MA).
 */
export function initialsFor(nameOrLogin: string): string {
  const words = nameOrLogin
    .split(/[\s_\-.]+/)
    .map((word) => word.trim())
    .filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}

/** Build a `ListPerson` from whatever identity string a provider hands over. */
export function personFrom(login: string, name?: string, avatarUrl?: string): ListPerson {
  return { id: login, initials: initialsFor(name || login), name: name || login, avatarUrl }
}

/**
 * The participants shown after the lead avatar: at most three, then a `+n`
 * tile. Returns the tile count as a number so the row can render it as its own
 * wash-3 chip rather than a person.
 */
export function participantsAfterLead(people: ListPerson[]): {
  shown: ListPerson[]
  overflow: number
} {
  const rest = people.slice(1)
  if (rest.length <= 3) return { shown: rest, overflow: 0 }
  return { shown: rest.slice(0, 3), overflow: rest.length - 3 }
}

/**
 * Every tint resolves to the same three-part recipe — a fill, a text mix, and
 * whether it rings. Components take one tint and read this, so no component
 * hand-picks a fill and a text colour separately and drifts.
 */
export function chipSkin(tint: ListTint | undefined): {
  background: string
  color: string
  boxShadow: string
} {
  switch (tint) {
    case 'primary':
    case 'running':
      return {
        background: 'color-mix(in oklch, var(--primary) 13%, transparent)',
        color: 'color-mix(in oklch, var(--primary) 82%, var(--foreground))',
        boxShadow: 'none',
      }
    case 'success':
      return {
        background: 'color-mix(in oklch, var(--success) 15%, transparent)',
        color: 'color-mix(in oklch, var(--success) 62%, var(--foreground))',
        boxShadow: 'none',
      }
    case 'warning':
      return {
        background: 'color-mix(in oklch, var(--warning) 17%, transparent)',
        color: 'color-mix(in oklch, var(--warning) 55%, var(--foreground))',
        boxShadow: 'none',
      }
    case 'failure':
      return {
        background: 'color-mix(in oklch, var(--failure) 13%, transparent)',
        color: 'color-mix(in oklch, var(--failure) 70%, var(--foreground))',
        boxShadow: 'none',
      }
    default:
      return {
        background: 'transparent',
        color: 'var(--muted-foreground)',
        boxShadow: '0 0 0 .5px color-mix(in oklch, var(--foreground) 13%, transparent)',
      }
  }
}

/** The lead statistic's colour — the one coloured word in the page header. */
export function statTintColor(tint: ListTint | undefined): string | undefined {
  switch (tint) {
    case 'running':
    case 'primary':
      return 'color-mix(in oklch, var(--running) 58%, var(--foreground))'
    case 'warning':
      return 'color-mix(in oklch, var(--warning) 58%, var(--foreground))'
    case 'success':
      return 'color-mix(in oklch, var(--success) 58%, var(--foreground))'
    case 'failure':
      return 'color-mix(in oklch, var(--failure) 58%, var(--foreground))'
    default:
      return undefined
  }
}
