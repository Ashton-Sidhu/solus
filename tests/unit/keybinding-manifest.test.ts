import { describe, expect, test } from 'bun:test'
import { KeybindingsContext } from '@solus/workspace-ui/lib/keybindings/dispatcher.svelte'
import { KEYBINDINGS } from '@solus/workspace-ui/lib/keybindings/manifest'
import { isMac } from '@solus/workspace-ui/lib/keybindings/match'

// Bun has no DOM. The dispatcher checks the target against HTMLElement.
const globals = globalThis as { HTMLElement?: new () => object }
globals.HTMLElement ??= class {}

describe('session task shortcuts', () => {
  test('keeps a new session distinct from a new task', () => {
    // WHY: a session has no task unless it joins one, so the N key starts a
    // session. New task and a session under the active task are commands with
    // no default key: a task is an entity a session links to, not a way in.
    expect(KEYBINDINGS['global.new-session']).toMatchObject({
      combo: { mod: true, code: 'KeyN' },
      web: { alt: true, shift: true, code: 'KeyN' },
      label: 'New session',
    })
    expect(KEYBINDINGS['global.new-task']).toMatchObject({ combo: null, label: 'New task' })
    expect(KEYBINDINGS['global.new-task']).not.toHaveProperty('web')
    expect(KEYBINDINGS['global.new-session-in-task']).toMatchObject({
      combo: null,
      label: 'New session in task',
    })
  })

  test('desktop Shift+N with the primary modifier opens a chat without a project', () => {
    const keybindings = new KeybindingsContext()
    keybindings.pushScope('global')
    const opened: string[] = []
    keybindings.register('global.new-session', () => { opened.push('project session') })
    keybindings.register('global.new-session-without-task', () => { opened.push('project session without task') })
    keybindings.register('global.new-chat', () => { opened.push('chat') })

    const keydown = (modifiers: { shiftKey: boolean; altKey: boolean }) => ({
      code: 'KeyN',
      metaKey: isMac,
      ctrlKey: !isMac,
      target: null,
      repeat: false,
      preventDefault() {},
      ...modifiers,
    }) as unknown as KeyboardEvent

    keybindings.dispatch(keydown({ shiftKey: true, altKey: false }))
    expect(opened).toEqual(['chat'])
    keybindings.dispatch(keydown({ shiftKey: false, altKey: true }))
    expect(opened).toEqual(['chat', 'project session without task'])
    keybindings.dispatch(keydown({ shiftKey: false, altKey: false }))
    expect(opened).toEqual(['chat', 'project session without task', 'project session'])
  })

  test('web keeps both actions clear of the private-window shortcut', () => {
    expect(KEYBINDINGS['global.new-chat']).toHaveProperty('web', { mod: true, alt: true, code: 'KeyN' })
    expect(KEYBINDINGS['global.new-session-without-task'].web).toEqual({ alt: true, shift: true, code: 'KeyU' })
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

  test('opens Threads from the conversation with a key free on desktop and web', () => {
    // WHY: what a session produced is a repeated look-up beside the
    // conversation. On web ⌥⇧E belongs to the organization switcher, so the
    // web default must be a different key.
    expect(KEYBINDINGS['conversation.open-artifacts']).toMatchObject({
      combo: { alt: true, shift: true, code: 'KeyE' },
      scope: 'global',
      label: 'Open threads',
      group: 'Conversation',
    })
    expect(KEYBINDINGS['conversation.open-artifacts'].web).not.toEqual(KEYBINDINGS['global.switch-organization'].web)
  })
})
