import { describe, expect, test } from 'bun:test'
import { KEYBINDINGS } from '@solus/workspace-ui/lib/keybindings/manifest'

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
      web: { alt: true, shift: true, code: 'KeyU' },
      label: 'New session without task',
    })
  })

  test('keeps browser-owned project and session shortcuts available on web', () => {
    // WHY: Chrome and Safari claim the primary-modifier O/N/T/W family before
    // a page can use it. Web defaults must stay in Solus's Alt+Shift layer.
    expect(KEYBINDINGS['global.select-project'].web).toEqual({
      alt: true,
      shift: true,
      code: 'KeyO',
    })
    expect(KEYBINDINGS['global.next-session'].web).toEqual({
      alt: true,
      shift: true,
      code: 'ArrowDown',
    })
    expect(KEYBINDINGS['global.prev-session'].web).toEqual({
      alt: true,
      shift: true,
      code: 'ArrowUp',
    })
    expect(KEYBINDINGS['global.toggle-sidebar'].web).toEqual({
      alt: true,
      shift: true,
      code: 'BracketLeft',
    })
    expect(KEYBINDINGS['global.save-prompt'].web).toEqual({
      alt: true,
      shift: true,
      code: 'KeyS',
    })
    expect(KEYBINDINGS['conversation.find'].web).toEqual({
      alt: true,
      shift: true,
      code: 'KeyF',
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

  test('reserves option shift I for Insights', () => {
    // WHY: global bindings dispatch in manifest order. If Design mode also
    // claims this combo, it consumes the key before Insights can open.
    expect(KEYBINDINGS['global.toggle-insights']).toMatchObject({
      combo: { alt: true, shift: true, code: 'KeyI' },
      scope: 'global',
      label: 'Open insights',
    })
    expect(KEYBINDINGS['global.design-mode'].combo).toBeNull()
  })

  test('opens Files with a non-numbered global shortcut', () => {
    // WHY: Files needs one default that works on desktop and web without
    // colliding with the fully occupied Option+Shift letter layer.
    expect(KEYBINDINGS['global.toggle-files']).toMatchObject({
      combo: { alt: true, shift: true, code: 'Semicolon' },
      scope: 'global',
      label: 'Open files',
    })
    expect(KEYBINDINGS['global.toggle-files'].web).toBeUndefined()
  })
})
