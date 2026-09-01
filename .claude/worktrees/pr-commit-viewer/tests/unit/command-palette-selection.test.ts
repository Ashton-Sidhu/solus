import { describe, expect, test } from 'bun:test'
import {
  moveCommandSelection,
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

describe('moveCommandSelection', () => {
  const commands: Command[] = [
    { id: 'first', label: 'First', group: 'General' },
    { id: 'second', label: 'Second', group: 'General' },
    { id: 'third', label: 'Third', group: 'View' },
  ]

  test('continues from the user-selected id after commands are inserted', () => {
    const updatedCommands: Command[] = [
      { id: 'new', label: 'New', group: 'General' },
      ...commands,
    ]

    expect(moveCommandSelection(updatedCommands, 'second', 'next', true)).toBe('third')
  })

  test('supports looping and group navigation without transient list state', () => {
    expect(moveCommandSelection(commands, 'third', 'next', true)).toBe('first')
    expect(moveCommandSelection(commands, 'second', 'next-group', true)).toBe('third')
    expect(moveCommandSelection(commands, 'third', 'previous-group', true)).toBe('first')
  })
})
