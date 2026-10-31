import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_PERSONAL_SETTINGS,
  personalSettingsDocumentSchema,
} from '../../packages/contracts/src/settings'
import {
  PROJECT_PANEL_SECTIONS,
  allPanelItemsHidden,
  isGitActionRowShown,
  isPanelItemShown,
  isSectionShown,
  withPanelItemShown,
} from '../../packages/workspace-ui/src/components/project-panel/lib/panel-items'

// The project panel's choice is synced across clients of different versions.
// It stores only what the person hid, so a new section or row shows by
// default, and it keeps ids this client does not know, so one client never
// erases another's.
describe('project panel items', () => {
  test('the default shows every section and every row', () => {
    const hidden = DEFAULT_PERSONAL_SETTINGS.projectPanelHiddenItems
    for (const section of PROJECT_PANEL_SECTIONS) {
      expect(isSectionShown(hidden, section.id)).toBe(true)
      for (const row of section.rows) expect(isPanelItemShown(hidden, row.id)).toBe(true)
    }
  })

  test('hiding and showing an item keeps ids from another version', () => {
    const fromNewerClient = ['git.timeline', 'git']
    const hidden = withPanelItemShown(fromNewerClient, 'environment.terminal', false)
    expect(hidden).toEqual(['git.timeline', 'git', 'environment.terminal'])
    expect(isPanelItemShown(hidden, 'environment.terminal')).toBe(false)

    const shownAgain = withPanelItemShown(hidden, 'git', true)
    expect(shownAgain).toEqual(['git.timeline', 'environment.terminal'])
  })

  test('hiding an item twice stores it once', () => {
    expect(withPanelItemShown(['goal.budget'], 'goal.budget', false)).toEqual(['goal.budget'])
  })

  test('the synced document accepts an id this version does not know', () => {
    const parsed = personalSettingsDocumentSchema.safeParse({ projectPanelHiddenItems: ['git.timeline', 'agents'] })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.projectPanelHiddenItems).toEqual(['git.timeline', 'agents'])
  })

  // A card with no row would be an empty box: a section hides once its last
  // row is off, as if the person had hidden the section itself.
  test('every section with rows hides when all of its rows are hidden', () => {
    for (const section of PROJECT_PANEL_SECTIONS) {
      if (section.rows.length === 0) continue
      const allRows = section.rows.map((row) => row.id)
      expect(isSectionShown(allRows, section.id)).toBe(false)
      expect(isSectionShown(allRows.slice(1), section.id)).toBe(true)
      expect(isSectionShown([section.id], section.id)).toBe(false)
    }
  })

  test('a section without row kinds hides only by its own id', () => {
    expect(isSectionShown([], 'webhooks')).toBe(true)
    expect(isSectionShown(['webhooks'], 'webhooks')).toBe(false)
  })

  test('hiding a section keeps its row choices for when it shows again', () => {
    const hidden = withPanelItemShown(['git.discard'], 'git', false)
    expect(withPanelItemShown(hidden, 'git', true)).toEqual(['git.discard'])
  })

  test('each Git action row maps to its own choice', () => {
    expect(isGitActionRowShown(['git.discard'], 'discard')).toBe(false)
    expect(isGitActionRowShown(['git.discard'], 'commit')).toBe(true)
    expect(isGitActionRowShown(['git.pullRequestAction'], 'pull-requests')).toBe(false)
    expect(isGitActionRowShown(['git.conflicts'], 'conflict')).toBe(false)
    // A row a later version adds shows until the person can choose it.
    expect(isGitActionRowShown(['git.discard'], 'stash')).toBe(true)
  })

  test('the empty state waits until the last section is hidden, and reset clears it', () => {
    const everySection = PROJECT_PANEL_SECTIONS.map((section) => section.id)
    expect(allPanelItemsHidden(everySection)).toBe(true)
    expect(allPanelItemsHidden(everySection.filter((id) => id !== 'webhooks'))).toBe(false)
    expect(allPanelItemsHidden(['environment', 'git', 'goal', 'agents', 'git.timeline'])).toBe(false)
    expect(allPanelItemsHidden([])).toBe(false)
  })
})
