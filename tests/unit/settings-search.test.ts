import { describe, expect, test } from 'bun:test'
import { settingMatches, settingVisible } from '@solus/client-core/settings-search'
import { settingsDefinitions } from '@solus/client-core/settings-definitions'
import { settingsByPage, chatSettings, sourceControlSettings } from '../../packages/workspace-ui/src/components/settings/lib/settings-search-data'
import { dataMatches, wordsMatch, settingsPageMatches, settingsPageQuery } from '../../packages/workspace-ui/src/components/settings/lib/settings-search'

describe('settings search', () => {
  test('matches query terms across a label, description, and aliases in any case', () => {
    const row = { label: 'Response streaming', description: 'Show paragraphs and code blocks as they finish.', keywords: ['buffered'] }
    expect(settingMatches('  STREAMING   paragraphs  ', row)).toBe(true)
    expect(settingMatches('buffered code', row)).toBe(true)
    expect(settingMatches('streaming voice', row)).toBe(false)
    expect(settingMatches('   ', row)).toBe(true)
    expect(wordsMatch('notif', ['Notifications'])).toBe(true)
  })

  test('GitHub is found from its displayed label without a search alias', () => {
    expect(sourceControlSettings.find((row) => row.id === 'github')?.keywords).toEqual([])
    for (const query of ['github', 'GitHub', 'gith']) {
      expect(settingsPageMatches('source-control', query)).toBe(true)
      expect(settingVisible(query, sourceControlSettings, 'github')).toBe(true)
    }
    expect(settingsPageMatches('source-control', 'voice')).toBe(false)
    expect(settingsPageMatches('source-control', 'repository history')).toBe(true)
    expect(settingVisible('repository history', sourceControlSettings, 'writing')).toBe(true)
  })

  test('every indexed row can be found by its display text before its page loads', () => {
    for (const [page, rows] of Object.entries(settingsByPage)) {
      for (const row of rows ?? []) {
        for (const query of [row.label, row.description].filter((text): text is string => !!text)) {
          expect(settingsPageMatches(page, query)).toBe(true)
          expect(settingVisible(query, rows!, row.id)).toBe(true)
        }
      }
    }
  })

  test('the same query finds the page and keeps its matching row visible', () => {
    const query = 'paragraphs code'
    expect(settingsPageMatches('chat', query)).toBe(true)
    const pageQuery = settingsPageQuery('chat', query)
    expect(pageQuery).toBe(query)
    expect(settingVisible(pageQuery, chatSettings, 'response-streaming')).toBe(true)
    expect(settingVisible(pageQuery, chatSettings, 'show-tool-calls')).toBe(false)
  })

  test('section headings and nested controls open their page without hiding all rows', () => {
    expect(settingsPageMatches('appearance', 'Typography')).toBe(true)
    expect(settingsPageQuery('appearance', 'Typography')).toBe('')
    expect(settingsPageMatches('general', 'Download updates automatically')).toBe(true)
    expect(settingsPageQuery('general', 'Download updates automatically')).toBe('')
    expect(settingsPageQuery('chat', 'no-such-setting')).toBe('no-such-setting')
  })

  test('static labels and descriptions remain searchable outside indexed row groups', () => {
    for (const [key, copy] of Object.entries(settingsDefinitions)) {
      const page = key.slice(0, key.indexOf('.'))
      expect(settingsPageMatches(page, copy.label)).toBe(true)
      if ('description' in copy) expect(settingsPageMatches(page, copy.description)).toBe(true)
    }
  })

  test('notification descriptions are searched with the same matcher as other rows', () => {
    expect(settingsPageMatches('notifications', 'waits for permission')).toBe(true)
  })

  test('a missing row definition is reported instead of silently hiding the setting', () => {
    expect(() => settingVisible('anything', chatSettings, 'missing')).toThrow('Missing setting definition')
  })

  test('shortcut and tool names remain searchable through their own data', () => {
    expect(dataMatches('keybindings', 'new session', {})).toBe(true)
    expect(dataMatches('keybindings', 'zzz-no-such-shortcut', {})).toBe(false)
    expect(dataMatches('tools', 'query insights', {})).toBe(true)
    expect(dataMatches('tools', 'zzz-no-such-tool', {})).toBe(false)
    expect(dataMatches('appearance', 'new session', {})).toBe(false)
  })
})
