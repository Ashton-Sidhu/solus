import { describe, expect, test } from 'bun:test'
import type { Input } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

  test('binds both the editor and each attached browser guest', () => {
    // WHY: binding only the guest still leaves Cmd+R inert whenever focus is in
    // the editor and Electron did not create its default reload menu.
    const mainSource = readFileSync(
      join(import.meta.dir, '../../apps/desktop/src/main/index.ts'),
      'utf8',
    )
    expect(mainSource).toContain('preserveApplicationReloadShortcut(editorContents, reloadEditor)')
    expect(mainSource).toContain('preserveApplicationReloadShortcut(browserContents, reloadEditor)')
  })
})
