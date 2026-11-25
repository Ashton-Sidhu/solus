import { describe, expect, mock, test } from 'bun:test'
import { withBinding, withBindingRemoved, type BindingOverrides } from '@solus/workspace-ui/lib/keybindings/editing'
import { formatComboText } from '@solus/workspace-ui/lib/keybindings/match'
import {
  commandsShown,
  moveCommandSelection,
  SUB_PAGE_ROWS_SHOWN,
  retainCommandSelection,
  type Command,
} from '@solus/workspace-ui/components/command-palette/lib/commands'

test('the New chat command shows the current shortcut, including when it is removed', async () => {
  mock.module('@solus/workspace-ui/lib/inputFocus', () => ({ requestInputFocus: () => {} }))
  const { newChatCommand } = await import('@solus/workspace-ui/components/command-palette/lib/new-chat-command')
  const settings: { keybindings: BindingOverrides } = { keybindings: {} }
  const command = newChatCommand({ settings } as Parameters<typeof newChatCommand>[0])
  const custom = { mod: true, shift: true, code: 'F9' }

  settings.keybindings = withBinding('global.new-chat', custom, settings.keybindings)
  expect(command.hint).toBe(formatComboText(custom))

  settings.keybindings = withBindingRemoved('global.new-chat', settings.keybindings)
  expect(command.hint).toBeUndefined()
})

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

describe('commandsShown', () => {
  // WHY: a branch sub-page holds a command per branch. In a repository with
  // thousands of branches, mounting all of them made the palette lag. The old
  // branches must still be one search away.
  const branches: Command[] = Array.from({ length: 4000 }, (_, index) =>
    ({ id: `branch:${index}`, label: `feature-${index}`, group: 'Git' }))

  test('a sub-page mounts a bounded number of rows and counts the rest', () => {
    const { shown, hiddenCount } = commandsShown(branches, '', true)
    expect(shown).toHaveLength(SUB_PAGE_ROWS_SHOWN)
    expect(hiddenCount).toBe(4000 - SUB_PAGE_ROWS_SHOWN)
  })

  test('a search reaches a command past the bound', () => {
    expect(commandsShown(branches, 'feature-3999', true).shown.map((command) => command.id)).toEqual(['branch:3999'])
  })

  test('quoted queries match whole phrases in command labels, keywords, and sub-pages', () => {
    const restore = { id: 'restore', label: 'Restore session', group: 'Current session' }
    const restores = { id: 'restores', label: 'Restore sessions', group: 'Current session' }
    const child = { id: 'child', label: 'Bring back conversation', group: 'Current session', keywords: ['restore session'] }
    const parent = { id: 'parent', label: 'More actions', group: 'Current session', children: [child], searchChildren: true }
    expect(commandsShown([restore, restores, parent], '"restore session"', false).shown).toEqual([restore, child])
    expect(commandsShown([restores, child], '“restore session”', true).shown).toEqual([child])
  })

  test('the root page is never cut', () => {
    expect(commandsShown(branches, '', false)).toEqual({ shown: branches, hiddenCount: 0 })
  })
})
