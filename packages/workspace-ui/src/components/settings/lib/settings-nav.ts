import type { SettingsTab } from '../../../contexts/workspace/routing/route-registry'

/**
 * The groups of the settings sidebar, in T3 Code's order: preferences first, then
 * Agents, Code, and Connections, and the rarely opened pages last. A group with a
 * hidden heading is set apart by space alone. Account is not in a group: the
 * sidebar footer opens it, as T3 Code's sign-in does.
 */
export const SETTINGS_NAV_GROUPS = ['Preferences', 'Agents', 'Code', 'Connections', 'Organization', 'More'] as const
export type SettingsNavGroup = (typeof SETTINGS_NAV_GROUPS)[number]

const HIDDEN_HEADINGS: ReadonlySet<SettingsNavGroup> = new Set(['Preferences', 'More'])

/** The page that the sidebar footer opens, not a row of a group. */
export const FOOTER_TAB: SettingsTab = 'account'

export interface SettingsNavPage<Tab extends { id: SettingsTab; group: SettingsNavGroup }> {
  group: SettingsNavGroup
  headingHidden: boolean
  items: Tab[]
}

/** True when the page shows for this person. Organization is for a signed-in person only. */
export function settingsTabShown(tabId: SettingsTab, isSignedIn: boolean): boolean {
  return tabId !== 'organization' || isSignedIn
}

/**
 * The group a page is in. Signed in, Policy is beside Organization, because most of
 * its policies are the organization's. Signed out, it keeps only this host's policy,
 * so it stays with the connections.
 */
export function settingsTabGroup(tab: { id: SettingsTab; group: SettingsNavGroup }, isSignedIn: boolean): SettingsNavGroup {
  return tab.id === 'policy' && isSignedIn ? 'Organization' : tab.group
}

/** The sidebar groups of these pages, in the order above, without empty groups and the footer page. */
export function settingsNavGroups<Tab extends { id: SettingsTab; group: SettingsNavGroup }>(
  tabs: readonly Tab[],
  isSignedIn: boolean,
): SettingsNavPage<Tab>[] {
  return SETTINGS_NAV_GROUPS.map((group) => ({
    group,
    headingHidden: HIDDEN_HEADINGS.has(group),
    items: tabs.filter((tab) => tab.id !== FOOTER_TAB && settingsTabGroup(tab, isSignedIn) === group),
  })).filter((section) => section.items.length > 0)
}
