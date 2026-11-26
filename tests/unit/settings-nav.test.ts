import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FOOTER_TAB, SETTINGS_NAV_GROUPS, settingsNavGroups, settingsTabShown, type SettingsNavGroup } from '@solus/workspace-ui/components/settings/lib/settings-nav'
import type { SettingsTab } from '@solus/workspace-ui/contexts/workspace/routing/route-registry'

// The settings sidebar follows T3 Code's groups. What matters: every page stays
// reachable (Account from the footer), Organization is there only for a person who
// is signed in, and Policy sits beside it then.

const SETTINGS_PAGE = readFileSync(join(import.meta.dir, '../../packages/workspace-ui/src/components/settings/SettingsPage.svelte'), 'utf8')
const tabs = [...SETTINGS_PAGE.matchAll(/\{\s*id: "([^"]+)",[^}]*?group: "([^"]+)"/g)].map((match) => ({
  // SAFETY: the page's own `TabMeta` type checks both values; this reads them back from the source.
  id: match[1] as SettingsTab,
  group: match[2] as SettingsNavGroup,
}))

describe('the settings sidebar', () => {
  test('lists the groups in T3 Code order, every page in a known group', () => {
    expect(tabs.length).toBeGreaterThan(20)
    for (const tab of tabs) expect(SETTINGS_NAV_GROUPS).toContain(tab.group)
    expect(settingsNavGroups(tabs, true).map((section) => section.group)).toEqual(['Preferences', 'Agents', 'Code', 'Connections', 'Organization', 'More'])
    expect(settingsNavGroups(tabs, true).filter((section) => section.headingHidden).map((section) => section.group)).toEqual(['Preferences', 'More'])
  })

  test('keeps every page reachable: each one in a group, or Account in the footer', () => {
    for (const isSignedIn of [true, false]) {
      const shown = tabs.filter((tab) => settingsTabShown(tab.id, isSignedIn))
      const inGroups = settingsNavGroups(shown, isSignedIn).flatMap((section) => section.items.map((tab) => tab.id))
      expect(new Set([...inGroups, FOOTER_TAB])).toEqual(new Set(shown.map((tab) => tab.id)))
    }
  })

  test('shows Organization only when signed in, with Policy beside it', () => {
    const groupOf = (isSignedIn: boolean, id: SettingsTab) =>
      settingsNavGroups(tabs.filter((tab) => settingsTabShown(tab.id, isSignedIn)), isSignedIn).find((section) => section.items.some((tab) => tab.id === id))?.group
    expect(groupOf(true, 'organization')).toBe('Organization')
    expect(groupOf(true, 'policy')).toBe('Organization')
    expect(groupOf(false, 'organization')).toBeUndefined()
    expect(groupOf(false, 'policy')).toBe('Connections')
  })
})
