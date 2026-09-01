import { describe, expect, test } from 'bun:test'
import { KEYBINDINGS } from '../../src/renderer/lib/keybindings/manifest'

describe('session task shortcuts', () => {
  test('keeps new tasks distinct from sessions created under the active task', () => {
    expect(KEYBINDINGS['global.new-task']).toMatchObject({
      combo: { mod: true, code: 'KeyN' },
      web: { alt: true, shift: true, code: 'KeyN' },
      label: 'New task',
    })
    expect(KEYBINDINGS['global.new-session']).toMatchObject({
      combo: { mod: true, code: 'KeyT' },
      web: { alt: true, shift: true, code: 'KeyT' },
      label: 'New session in task',
    })
    expect(KEYBINDINGS['global.new-session-without-task']).toMatchObject({
      combo: { mod: true, shift: true, code: 'KeyN' },
      label: 'New session without task',
    })
  })
})
