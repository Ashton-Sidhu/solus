import type { Component } from 'svelte'
import {
  Braces,
  CalendarClock,
  Folder,
  History,
  KeyRound,
  LayoutDashboard,
  MessagesSquare,
  Radio,
  Rocket,
  ScrollText,
  SlidersHorizontal,
  Webhook,
  Workflow,
} from '@lucide/svelte'
import type { AppState, AppSummary } from '@solus/contracts/apps'
import { APP_MANAGE_SECTIONS, type AppManageSection } from '../../../contexts/workspace/routing/route-registry'
import type { AppProblem } from './app-view'

/**
 * The Manage page of one app (docs/plans/apps.md §9.2): its sections, in the
 * groups and the order the section list and the strip show them, and the count
 * at the edge of each row. Pure, so the rules are tested without a host.
 */

const SECTION_LABELS = {
  overview: 'Overview',
  activity: 'Activity',
  workflows: 'Workflows',
  versions: 'Versions',
  deployment: 'Deployment',
  schedules: 'Schedules',
  webhooks: 'Webhooks',
  signals: 'Signals',
  secrets: 'Secrets',
  config: 'Config',
  files: 'Files',
  operations: 'Operations',
  sessions: 'Sessions',
} satisfies { [Section in AppManageSection]: string }

/** The icon of each section: the strip of a narrow pane shows it, and the section's empty state. */
const SECTION_ICONS = {
  overview: LayoutDashboard,
  activity: ScrollText,
  workflows: Workflow,
  versions: History,
  deployment: Rocket,
  schedules: CalendarClock,
  webhooks: Webhook,
  signals: Radio,
  secrets: KeyRound,
  config: SlidersHorizontal,
  files: Folder,
  operations: Braces,
  sessions: MessagesSquare,
} satisfies { [Section in AppManageSection]: Component }

export interface AppManageSectionEntry {
  id: AppManageSection
  label: string
  icon: Component
}

function sectionEntry(id: AppManageSection): AppManageSectionEntry {
  return { id, label: SECTION_LABELS[id], icon: SECTION_ICONS[id] }
}

export function manageSectionIcon(section: AppManageSection): Component {
  return SECTION_ICONS[section]
}

export function manageSectionLabel(section: AppManageSection): string {
  return SECTION_LABELS[section]
}

/** Every section. The section list and the strip draw the same list. */
export function manageSections(): AppManageSectionEntry[] {
  return APP_MANAGE_SECTIONS.map(sectionEntry)
}

export interface AppManageSectionGroup {
  label: string
  sections: AppManageSectionEntry[]
}

const SECTION_GROUPS: { label: string; sections: AppManageSection[] }[] = [
  { label: 'Run', sections: ['overview', 'activity', 'workflows', 'sessions'] },
  { label: 'Triggers', sections: ['schedules', 'webhooks', 'signals'] },
  { label: 'Build', sections: ['operations', 'versions', 'deployment'] },
  { label: 'Settings', sections: ['secrets', 'config', 'files'] },
]

/** The sections under their headings. The groups hold every section once, in the order of `manageSections`. */
export function manageSectionGroups(): AppManageSectionGroup[] {
  return SECTION_GROUPS.map((group) => ({ label: group.label, sections: group.sections.map(sectionEntry) }))
}

/**
 * The figure at the edge of a section's row. `tone` is null for a plain count
 * (how many the app has); `error` or `warning` for a count of problems, which
 * the strip of a narrow pane shows too.
 */
export interface AppManageSectionCount {
  count: number
  tone: AppProblem['tone'] | null
}

/** The figure of each section that has one. */
export type AppManageSectionCounts = { [Section in AppManageSection]?: AppManageSectionCount }

/**
 * The count of each section, from the facts the page has already: the app's
 * summary and its state. A section with no cheap fact has no count. A problem
 * count replaces the plain count, because it is what the owner must see.
 */
export function manageSectionCounts(
  app: Pick<AppSummary, 'failed24h' | 'operationCount' | 'latestVersion'>,
  state: Pick<AppState, 'descriptor' | 'secrets'> | undefined,
  problems: readonly Pick<AppProblem, 'section' | 'tone'>[],
): AppManageSectionCounts {
  const descriptor = state?.descriptor
  const plain = (count: number | undefined): AppManageSectionCount | undefined => (count ? { count, tone: null } : undefined)
  const counts: AppManageSectionCounts = {
    activity: app.failed24h > 0 ? { count: app.failed24h, tone: 'error' } : undefined,
    workflows: plain(descriptor?.workflows.length),
    schedules: plain(descriptor?.schedules.length),
    webhooks: plain(descriptor?.webhooks.length),
    signals: plain(descriptor?.signals.length),
    operations: plain(app.operationCount),
    versions: plain(app.latestVersion ?? undefined),
    secrets: plain(state?.secrets.length),
  }
  for (const section of APP_MANAGE_SECTIONS) {
    const own = problems.filter((problem) => problem.section === section)
    if (own.length === 0) continue
    counts[section] = { count: own.length, tone: own.some((problem) => problem.tone === 'error') ? 'error' : 'warning' }
  }
  return counts
}

/** The section the page shows: the one the route names, or Overview. */
export function manageSectionOf(requested: AppManageSection | undefined): AppManageSection {
  return requested ?? 'overview'
}

/** The section after or before `current`, for the arrow keys of the rail and the strip. It stops at each end. */
export function adjacentManageSection(current: AppManageSection, delta: 1 | -1): AppManageSection {
  const index = APP_MANAGE_SECTIONS.indexOf(current) + delta
  return APP_MANAGE_SECTIONS[Math.max(0, Math.min(APP_MANAGE_SECTIONS.length - 1, index))] ?? current
}
