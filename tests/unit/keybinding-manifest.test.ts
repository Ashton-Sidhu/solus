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

  test('opens the task picker with the global shortcut pattern', () => {
    // WHY: restoring a task is a repeated navigation action, so it must remain
    // available without moving focus from the active composer to the sidebar.
    expect(KEYBINDINGS['global.task-picker']).toMatchObject({
      combo: { alt: true, shift: true, code: 'KeyF' },
      scope: 'global',
      label: 'Task picker',
    })
  })

  test('focuses sidebar task search with control slash', () => {
    // WHY: task search is a repeated navigation action. Control-slash stays
    // available without claiming ordinary slash input from the composer.
    expect(KEYBINDINGS['global.focus-sidebar-task-search']).toMatchObject({
      combo: { ctrl: true, code: 'Slash' },
      scope: 'global',
      label: 'Focus sidebar task search',
    })
  })
})
