import { describe, expect, it } from 'bun:test'
import { prNavigationTarget } from '../../src/renderer/components/session/lib/pr-navigation'

describe('PR chip navigation', () => {
  it('always opens through the client host in the secondary pane', () => {
    // WHY: neither dispatch placement nor durable task ownership is navigation
    // state. Clicking a chip must stay on the host this client is using.
    expect(prNavigationTarget({
      clientServerId: 'client-host',
      projectDirectory: '/Users/sidhu/solus',
      taskServerId: 'task-host',
      attemptServerId: 'remote-run-host',
    })).toEqual({
      serverId: 'client-host',
      projectDirectory: '/Users/sidhu/solus',
      paneTarget: 'aside',
    })
  })
})
