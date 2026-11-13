import { APP_MANAGE_SECTIONS, type AppManageSection } from '../../../contexts/workspace/routing/route-registry'
import type { AppProblem } from './app-view'

/**
 * The Manage page of one app (docs/plans/apps.md §9.2): its sections, in the
 * order the rail and the strip list them. Pure, so the rules are tested
 * without a host.
 */

const SECTION_LABELS = {
  overview: 'Overview',
  activity: 'Activity',
  workflows: 'Workflows',
  versions: 'Versions',
  schedules: 'Schedules',
  webhooks: 'Webhooks',
  signals: 'Signals',
  models: 'Models',
  secrets: 'Secrets',
  config: 'Config',
  files: 'Files',
  operations: 'Operations',
  sessions: 'Sessions',
  source: 'Source',
} satisfies { [Section in AppManageSection]: string }

export interface AppManageSectionEntry {
  id: AppManageSection
  label: string
  /** The worst problem that leads to this section; null when none does. */
  problemTone: AppProblem['tone'] | null
}

export function manageSectionLabel(section: AppManageSection): string {
  return SECTION_LABELS[section]
}

/** Every section, each with the mark of the problems the owner fixes there. The rail and the strip draw the same list. */
export function manageSections(problems: readonly AppProblem[] = []): AppManageSectionEntry[] {
  return APP_MANAGE_SECTIONS.map((id) => {
    const tones = problems.filter((problem) => problem.section === id).map((problem) => problem.tone)
    return { id, label: SECTION_LABELS[id], problemTone: tones.includes('error') ? 'error' : tones.includes('warning') ? 'warning' : null }
  })
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
