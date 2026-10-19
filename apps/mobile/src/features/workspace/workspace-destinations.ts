import type { WorkspaceTab } from './workspace-tabs-state'

/**
 * The top-level destinations of the Android workspace navigation: the two
 * list tabs and Settings (docs/plans/mobile-pull-requests.md). The list tab
 * is workspace state (workspace-tabs-state.ts); Settings is not. Settings is
 * selected while its pages are on top of the root stack, so Back, deep links,
 * and every other way in or out keep the selection true.
 */
export type WorkspaceDestination = WorkspaceTab | 'settings'

/** Settings and the pages it pushes. */
export const SETTINGS_PAGE_ROUTES: ReadonlySet<string> = new Set([
  'Settings',
  'AccountSync',
  'AgentProfile',
  'AppearanceSettings',
  'AgentDefaults',
  'NotificationSettings',
  'OrganizationSettings',
  'HostSettings',
  'HostAccess',
  'Integrations',
  'GitHubConnection',
  'About',
])

/** The part of the root stack the destinations read. */
export interface WorkspaceStackHistory {
  readonly index: number
  readonly routes: readonly { readonly name: string }[]
}

/**
 * How many routes on top of the stack belong to Settings, down to and
 * including Settings itself; 0 when Settings is not the destination. A
 * settings page opened from elsewhere (a host's settings from Hosts) does not
 * select Settings.
 */
export function settingsPagesOnTop(history: WorkspaceStackHistory): number {
  let count = 0
  for (let index = history.index; index >= 0; index--) {
    const name = history.routes[index]?.name
    if (name === undefined || !SETTINGS_PAGE_ROUTES.has(name)) return 0
    count++
    if (name === 'Settings') return count
  }
  return 0
}

/**
 * Settings was opened as a destination from the workspace root: its pages lie
 * directly on Home. Only then does a phone show the navigation bar under
 * Settings; Settings opened over a conversation stays an ordinary page whose
 * Back returns to that conversation.
 */
export function settingsOpenedFromHome(history: WorkspaceStackHistory): boolean {
  const pages = settingsPagesOnTop(history)
  return pages > 0 && history.routes[history.index - pages]?.name === 'Home'
}

/** What choosing a destination does to the root stack and the list tab. */
export interface WorkspaceDestinationChange {
  /** Routes to pop off the top of the root stack, before anything else. */
  readonly pop: number
  /** The list tab to select; a tab change clears search. */
  readonly select: WorkspaceTab | null
  readonly openSettings: boolean
}

const NO_CHANGE: WorkspaceDestinationChange = { pop: 0, select: null, openSettings: false }

/**
 * The change for choosing `destination`. History is kept: Settings opens over
 * the current location, and choosing the shown list tab from Settings closes
 * Settings and returns to where the person was. A different list tab shows on
 * the workspace root, as the iPad sidebar picker does (WorkspaceSidebarTabs):
 * a split layout shows the Pull Requests list in Home's detail pane.
 */
export function workspaceDestinationChange(
  history: WorkspaceStackHistory,
  selectedTab: WorkspaceTab,
  destination: WorkspaceDestination,
): WorkspaceDestinationChange {
  const settingsPages = settingsPagesOnTop(history)
  if (destination === 'settings') {
    return settingsPages > 0 ? NO_CHANGE : { pop: 0, select: null, openSettings: true }
  }
  if (destination === selectedTab) return settingsPages > 0 ? { ...NO_CHANGE, pop: settingsPages } : NO_CHANGE
  let home = history.index
  while (home >= 0 && history.routes[home]?.name !== 'Home') home--
  return { pop: home >= 0 ? history.index - home : settingsPages, select: destination, openSettings: false }
}
