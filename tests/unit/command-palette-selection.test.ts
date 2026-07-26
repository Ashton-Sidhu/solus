import { describe, expect, test } from 'bun:test'
import {
  retainCommandSelection,
  type Command,
} from '../../src/renderer/components/command-palette/lib/commands'

describe('retainCommandSelection', () => {
  const commands: Command[] = [
    { id: 'first', label: 'First', group: 'Commands' },
    { id: 'second', label: 'Second', group: 'Commands' },
  ]

  test('preserves keyboard selection when live commands are added', () => {
    const updatedCommands = [
      { id: 'new', label: 'New', group: 'Commands' },
      ...commands,
    ]

    expect(retainCommandSelection(updatedCommands, 'second')).toBe('second')
  })

  test('falls back only when the selected command is no longer visible', () => {
    expect(retainCommandSelection(commands, 'removed')).toBe('first')
    expect(retainCommandSelection([], 'removed')).toBe('')
  })
})
