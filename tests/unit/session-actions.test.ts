import { describe, expect, test } from 'bun:test'
import { filterSessionActions, type SessionAction } from '@solus/workspace-ui/components/layout/lib/session-actions'

const action = (id: string, label: string): SessionAction => ({
  id,
  label,
  icon: (() => {}) as unknown as SessionAction['icon'],
  shortcut: '',
  run: () => {},
})

const actions = [
  action('pin', 'Pin session to sidebar'),
  action('fork', 'Fork session into a new tab'),
  action('worktree', 'Continue in a new worktree'),
  action('insights', 'Open session in insights'),
  action('terminal', 'Open session in terminal'),
]

describe('filterSessionActions', () => {
  test('an empty query keeps every action in row order', () => {
    expect(filterSessionActions(actions, '  ').map(a => a.id)).toEqual(['pin', 'fork', 'worktree', 'insights', 'terminal'])
  })

  test('every typed word must appear, so a second word narrows the list', () => {
    expect(filterSessionActions(actions, 'open').map(a => a.id)).toEqual(['insights', 'terminal'])
    expect(filterSessionActions(actions, 'open term').map(a => a.id)).toEqual(['terminal'])
  })

  test('a label that starts with the query ranks above one that only contains it', () => {
    const terminals = [action('open', 'Open session in terminal'), action('settings', 'Terminal settings')]
    expect(filterSessionActions(terminals, 'term').map(a => a.id)).toEqual(['settings', 'open'])
    // No label starts with "ses", so the row order holds.
    expect(filterSessionActions(actions, 'ses').map(a => a.id)).toEqual(['pin', 'fork', 'insights', 'terminal'])
  })

  test('matching ignores case and reports no match as an empty list', () => {
    expect(filterSessionActions(actions, 'FORK').map(a => a.id)).toEqual(['fork'])
    expect(filterSessionActions(actions, 'deploy')).toEqual([])
  })
})
