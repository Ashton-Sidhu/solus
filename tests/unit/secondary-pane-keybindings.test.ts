import { describe, expect, test } from 'bun:test'
import { KeybindingsContext } from '@solus/workspace-ui/lib/keybindings/dispatcher.svelte'
import { isMac } from '@solus/workspace-ui/lib/keybindings/match'

// The dispatcher checks editable targets with HTMLElement. Bun has no DOM, and
// these focused tests use a null event target so only scope dispatch is tested.
const globals = globalThis as { HTMLElement?: unknown }
globals.HTMLElement ??= class {}

function keyEvent(code: string, modifiers: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    code,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    repeat: false,
    target: null,
    preventDefault: () => {},
    ...modifiers,
  } as unknown as KeyboardEvent
}

function modKeyEvent(code: string): KeyboardEvent {
  return keyEvent(code, isMac ? { metaKey: true } : { ctrlKey: true })
}

describe('global shortcuts with a secondary document pane', () => {
  test('Settings reaches the global scope while a pane scope is active', () => {
    // WHY: opening a document beside a conversation must not disable Command+,.
    const keybindings = new KeybindingsContext()
    keybindings.pushScope('global')
    keybindings.pushScope('document-modal')
    let settingsOpened = 0
    keybindings.register('global.settings', () => { settingsOpened += 1 })

    keybindings.dispatch(modKeyEvent('Comma'))

    expect(settingsOpened).toBe(1)
  })

  test('the pane scope still wins when it owns the same shortcut', () => {
    // WHY: making an inline pane non-exclusive must not send Command+F to the
    // conversation when the document owns Find.
    const keybindings = new KeybindingsContext()
    keybindings.pushScope('global')
    keybindings.pushScope('document-modal')
    let documentFindOpened = 0
    let conversationFindOpened = 0
    keybindings.register('document-modal.find', () => { documentFindOpened += 1 })
    keybindings.register('conversation.find', () => { conversationFindOpened += 1 })

    keybindings.dispatch(modKeyEvent('KeyF'))

    expect([documentFindOpened, conversationFindOpened]).toEqual([1, 0])
  })
})
