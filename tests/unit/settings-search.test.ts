import { describe, expect, test } from 'bun:test'
import { SOURCE_CONTROL_SEARCH_WORDS, dataMatches, wordsMatch } from '../../packages/workspace-ui/src/components/settings/lib/settings-search'

// Settings search covers every page. A page with no word list must still be
// found through the data its rows are built from, or a search from another
// page cannot reach it.
describe('settings search', () => {
  test('a word matches a part of a search word, in any case', () => {
    expect(wordsMatch('Dark', ['theme', 'dark'])).toBe(true)
    expect(wordsMatch('notif', ['Notifications'])).toBe(true)
    expect(wordsMatch('voice', ['theme', 'dark'])).toBe(false)
  })

  test('a shortcut name finds the Keybindings page', () => {
    expect(dataMatches('keybindings', 'new session', {})).toBe(true)
    expect(dataMatches('keybindings', 'zzz-no-such-shortcut', {})).toBe(false)
  })

  test('a Solus tool name finds the Tools page', () => {
    expect(dataMatches('tools', 'query insights', {})).toBe(true)
    expect(dataMatches('tools', 'zzz-no-such-tool', {})).toBe(false)
  })

  test('a page without data rows matches nothing through data', () => {
    expect(dataMatches('appearance', 'new session', {})).toBe(false)
  })

  // The commit and pull request writing setting is on the Source control
  // page. A person who looks for it by what it writes must find that page.
  test('a search for commit or pull request words finds the Source control page', () => {
    expect(wordsMatch('pull request', SOURCE_CONTROL_SEARCH_WORDS)).toBe(true)
    expect(wordsMatch('commit message', SOURCE_CONTROL_SEARCH_WORDS)).toBe(true)
    expect(wordsMatch('voice', SOURCE_CONTROL_SEARCH_WORDS)).toBe(false)
  })
})
