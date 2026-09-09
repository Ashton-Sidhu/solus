import { afterEach, expect, test } from 'bun:test'
import { loadPickerResultType, savePickerResultType } from '@solus/workspace-ui/components/session/unified-picker/lib/picker-preferences'

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

test('result type survives a fresh read and defaults to sessions and tasks', () => {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  })
  expect(loadPickerResultType()).toBe('all')
  savePickerResultType('sessions')
  expect(loadPickerResultType()).toBe('sessions')
  savePickerResultType('tasks')
  expect(loadPickerResultType()).toBe('tasks')
  savePickerResultType('all')
  expect(loadPickerResultType()).toBe('all')
})

test('blocked browser storage does not prevent using the picker', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('Storage blocked') },
  })
  expect(loadPickerResultType()).toBe('all')
  expect(() => savePickerResultType('sessions')).not.toThrow()
})
