import { describe, expect, test } from 'bun:test'
import type { Input } from 'electron'
import type { GuestShortcut } from '@solus/contracts/host-api'
import {
  forwardGuestShortcuts,
  isApplicationReloadInput,
  matchGuestShortcut,
  preserveApplicationReloadShortcut,
} from '../../apps/desktop/src/main/browser/guest-shortcuts'
import { guestShortcuts } from '../../packages/workspace-ui/src/lib/keybindings/guest-shortcuts'

function input(overrides: Partial<Input> = {}): Input {
  return {
    type: 'keyDown',
    key: 'r',
    code: 'KeyR',
    isAutoRepeat: false,
    isComposing: false,
    shift: false,
    control: false,
    alt: false,
    meta: false,
    location: 0,
    modifiers: [],
    ...overrides,
  }
}

describe('browser guest application reload shortcut', () => {
  test('recognizes Cmd+R on macOS', () => {
    expect(isApplicationReloadInput(input({ meta: true }), 'darwin')).toBe(true)
  })

  test('recognizes Ctrl+R on Windows and Linux', () => {
    expect(isApplicationReloadInput(input({ control: true }), 'win32')).toBe(true)
    expect(isApplicationReloadInput(input({ control: true }), 'linux')).toBe(true)
  })

  test('does not take the browser page reload variants', () => {
    expect(isApplicationReloadInput(input({ meta: true, shift: true }), 'darwin')).toBe(false)
    expect(isApplicationReloadInput(input({ meta: true, alt: true }), 'darwin')).toBe(false)
    expect(isApplicationReloadInput(input({ meta: true, type: 'keyUp' }), 'darwin')).toBe(false)
    expect(isApplicationReloadInput(input({ meta: true, isAutoRepeat: true }), 'darwin')).toBe(false)
  })

  test('prevents the guest shortcut and reloads the application renderer', () => {
    let listener: ((event: { preventDefault(): void }, input: Input) => void) | undefined
    let prevented = false
    let reloads = 0
    preserveApplicationReloadShortcut(
      {
        on: (_event, nextListener) => {
          listener = nextListener
        },
      },
      () => reloads++,
    )

    listener?.({ preventDefault: () => { prevented = true } }, input({ meta: true }))

    expect(prevented).toBe(true)
    expect(reloads).toBe(1)
  })
})

// WHY: a focused browser page is its own process, so its keystrokes never reach
// the Solus keybinding listener. Without forwarding, every Solus shortcut is
// dead while a page has focus; forwarding too much takes keys the page owns.
describe('browser guest forwards Solus shortcuts', () => {
  const toggleTasks: GuestShortcut = { code: 'KeyT', alt: true, shift: true, meta: false, ctrl: false }

  test('a named shortcut is taken from the page and handed to Solus once', () => {
    let listener: ((event: { preventDefault(): void }, input: Input) => void) | undefined
    let prevented = 0
    const forwarded: GuestShortcut[] = []
    forwardGuestShortcuts({ on: (_event, next) => { listener = next } }, () => [toggleTasks], (shortcut) => forwarded.push(shortcut))

    const keystroke = input({ code: 'KeyT', alt: true, shift: true })
    listener?.({ preventDefault: () => { prevented++ } }, keystroke)
    listener?.({ preventDefault: () => { prevented++ } }, { ...keystroke, isAutoRepeat: true })

    expect(forwarded).toEqual([toggleTasks])
    expect(prevented).toBe(2)
  })

  test('other keys, and the same key with other modifiers, stay with the page', () => {
    expect(matchGuestShortcut(input({ code: 'KeyT', alt: true }), [toggleTasks])).toBeNull()
    expect(matchGuestShortcut(input({ code: 'KeyT', meta: true }), [toggleTasks])).toBeNull()
    expect(matchGuestShortcut(input({ code: 'KeyT', alt: true, shift: true, type: 'keyUp' }), [toggleTasks])).toBeNull()
  })
})

describe('the shortcuts a browser page gives up', () => {
  test('Solus ⌥ shortcuts are named, resolved for the platform', () => {
    expect(guestShortcuts({}, true)).toContainEqual({ code: 'KeyT', alt: true, shift: true, meta: false, ctrl: false })
    expect(guestShortcuts({}, true)).toContainEqual({ code: 'KeyR', alt: true, shift: false, meta: false, ctrl: false })
  })

  test('⌘ and ⌃ shortcuts stay with the page, which binds them itself', () => {
    const shortcuts = guestShortcuts({}, true)
    expect(shortcuts.some((shortcut) => shortcut.code === 'KeyK' && shortcut.meta)).toBe(false)
    expect(shortcuts.every((shortcut) => shortcut.alt)).toBe(true)
  })

  test('a rebound shortcut is forwarded under its new keys, and a removed one is not', () => {
    const rebound = guestShortcuts({ 'global.command-palette': { alt: true, shift: true, code: 'KeyJ', mod: true } }, false)
    expect(rebound).toContainEqual({ code: 'KeyJ', alt: true, shift: true, meta: false, ctrl: true })
    const removed = guestShortcuts({ 'global.toggle-tasks': null }, true)
    expect(removed.some((shortcut) => shortcut.code === 'KeyT' && shortcut.shift)).toBe(false)
  })
})
