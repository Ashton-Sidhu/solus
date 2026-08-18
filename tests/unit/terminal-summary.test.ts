import { describe, expect, test } from 'bun:test'

import { terminalRowDescription } from '../../src/renderer/components/settings/lib/terminal-summary'

describe('terminalRowDescription', () => {
  test('names the attached terminal as the one that will be reused', () => {
    // WHY: the row is titled "Fallback terminal", so it has to say plainly when
    // the fallback is not what will open.
    const description = terminalRowDescription({ id: 'wezterm', name: 'WezTerm', source: 'attached' })

    expect(description).toContain('WezTerm is attached')
    expect(description).toContain('reused')
  })

  test('names the fallback as the one that will open when nothing is attached', () => {
    const description = terminalRowDescription({ id: 'ghostty', name: 'Ghostty', source: 'fallback' })

    expect(description).toContain('Nothing is attached')
    expect(description).toContain('Ghostty opens')
  })

  test('explains the rule rather than guessing before the host has answered', () => {
    // WHY: a row that claims an outcome it has not resolved yet is a lying label.
    const description = terminalRowDescription(null)

    expect(description).toContain('reused')
    expect(description).not.toContain('right now')
  })
})
