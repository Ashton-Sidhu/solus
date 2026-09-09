import { describe, expect, test } from 'bun:test'
import type { Input } from 'electron'
import {
  isApplicationReloadInput,
  preserveApplicationReloadShortcut,
} from '../../apps/desktop/src/main/browser/guest-shortcuts'

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
