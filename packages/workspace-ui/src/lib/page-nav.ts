/**
 * The five routed page destinations, named once.
 *
 * The session sidebar's nav rows navigate between them; the page breadcrumb and
 * the sub-page crumb read the same labels and glyphs to state where you are.
 * When a sixth page arrives it is added here and every surface gains it
 * together.
 *
 * History is deliberately absent: it summons the session picker overlay rather
 * than navigating, so there is no route to put in a pane.
 */

import type { WorkspaceContext } from '../contexts'

export type NavPage = 'folio' | 'automations' | 'insights' | 'prs' | 'tasks'

export interface NavPageSpec {
  id: NavPage
  /** What the page calls itself, in the crumb and in the rail. */
  label: string
}

/** Rail order, so a surface that lists the pages does it the way the sidebar
 *  does. */
export const NAV_PAGES: readonly NavPageSpec[] = [
  { id: 'folio', label: 'Workspace' },
  { id: 'automations', label: 'Automations' },
  { id: 'insights', label: 'Insights' },
  { id: 'prs', label: 'Pull requests' },
  { id: 'tasks', label: 'Tasks' },
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
