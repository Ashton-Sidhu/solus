import { describe, expect, mock, test } from 'bun:test'

type KeyboardListener = (event: { height: number }) => void
const listeners = new Map<string, KeyboardListener[]>()
const emit = (name: string, height: number) => { for (const listener of listeners.get(name) ?? []) listener({ height }) }

const { join } = await import('node:path')
const bindings = join(process.cwd(), 'node_modules/react-native-keyboard-controller/src/bindings')
mock.module(bindings, () => ({
  KeyboardControllerNative: { dismiss: () => {} },
  KeyboardEvents: {
    addListener: (name: string, listener: KeyboardListener) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      return { remove: () => {} }
    },
  },
}))
const { KeyboardController } = await import('../../node_modules/react-native-keyboard-controller/src/module')

/**
 * On a resume or a split-screen change, Android repairs the IME inset with
 * keyboardDidShow and no keyboardWillShow. The module cache must read it, or the
 * composer inset and the dismiss after a send act on a hidden keyboard.
 */
describe('keyboard state on a show with no animation', () => {
  test('keyboardDidShow alone reports the keyboard as visible', () => {
    emit('keyboardDidHide', 0)
    expect(KeyboardController.isVisible()).toBe(false)
    emit('keyboardDidShow', 376)
    expect(KeyboardController.isVisible()).toBe(true)
    expect(KeyboardController.state().height).toBe(376)
  })
})
