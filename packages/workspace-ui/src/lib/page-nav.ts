/**
 * The five routed page destinations, named once.
 *
 * Two surfaces navigate between them and must agree on the set, the labels, the
 * glyphs and the shortcuts: the session sidebar's nav rows, and the page
 * breadcrumb's second segment. When a sixth page arrives it is added here and
 * both surfaces gain it together.
 *
 * History is deliberately absent: it summons the session picker overlay rather
 * than navigating, so there is no route to put in a pane.
 */

import {
  LibraryBig as FolioIcon,
  RefreshCw as AutomationsIcon,
  ChartBar as InsightsIcon,
  GitPullRequest as PrsIcon,
  ListChecks as TasksIcon,
} from '@lucide/svelte'
import type { WorkspaceContext } from '../contexts'
import type { BindingId } from './keybindings/manifest'

export type NavPage = 'folio' | 'automations' | 'insights' | 'prs' | 'tasks'

/** Phosphor/Lucide icon components, typed off a real icon — the same pattern
 *  `list-page.ts` uses for its filter glyphs. */
type NavIcon = typeof FolioIcon

export interface NavPageSpec {
  id: NavPage
  /** What the page calls itself, in the crumb and in the rail. */
  label: string
  icon: NavIcon
  /** Absent for Pull requests, which has no global shortcut. */
  shortcut?: BindingId
}

/** Rail order, so the crumb menu lists them the way the sidebar does. */
export const NAV_PAGES: readonly NavPageSpec[] = [
  { id: 'folio', label: 'Workspace', icon: FolioIcon, shortcut: 'global.toggle-workspace' },
  {
    id: 'automations',
    label: 'Automations',
    icon: AutomationsIcon,
    shortcut: 'global.toggle-automations',
  },
  { id: 'insights', label: 'Insights', icon: InsightsIcon, shortcut: 'global.toggle-insights' },
  { id: 'prs', label: 'Pull requests', icon: PrsIcon },
  { id: 'tasks', label: 'Tasks', icon: TasksIcon, shortcut: 'global.toggle-tasks' },
]

export function navPageSpec(page: NavPage): NavPageSpec {
  // Every `NavPage` has a row above, so the fallback is unreachable — it exists
  // so callers get a spec rather than `undefined` to guard.
  return NAV_PAGES.find((spec) => spec.id === page) ?? NAV_PAGES[0]
}

/** Show one page. `aside` puts it in the companion pane beside the conversation. */
export function openNavPage(
  session: WorkspaceContext,
  page: NavPage,
  target: 'focused' | 'aside' = 'focused',
): void {
  switch (page) {
    case 'folio':
      session.openFolio('click', target)
      break
    case 'automations':
      session.openAutomations(null, 'click', target)
      break
    case 'insights':
      session.openInsights('click', target)
      break
    case 'prs':
      session.openPrs(null, 'click', target)
      break
    case 'tasks':
      session.openTasks('click', target)
      break
  }
}
