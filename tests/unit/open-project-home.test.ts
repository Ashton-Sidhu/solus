import { describe, expect, test } from 'bun:test'
import { homeRows } from '@solus/workspace-ui/components/servers/lib/open-project-home'

describe('Open project home', () => {
  test('New project is the first action, with or without GitHub', () => {
    // WHY: a new user with nothing to open must see how to start from nothing
    // first — before the ways to open code they do not have.
    for (const githubAvailable of [true, false]) {
      const actions = homeRows({ intent: { kind: 'empty' }, recents: [], githubAvailable })
        .filter((row) => row.kind === 'action')
        .map((row) => row.kind === 'action' && row.action)
      expect(actions[0]).toBe('new')
    }
  })
})
