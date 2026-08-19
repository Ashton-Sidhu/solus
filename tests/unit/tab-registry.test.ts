import { afterEach, describe, expect, test } from 'bun:test'
import type { Session, Tab } from '@solus/contracts/types'

const previousState = (globalThis as unknown as { $state?: unknown }).$state

afterEach(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

describe('tab registry selection', () => {
  test('marks a tab as read whenever it becomes active', async () => {
    ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
    const { TabRegistry } = await import('@solus/workspace-ui/contexts/workspace/tab-registry.svelte')
    const registry = new TabRegistry()
    registry.tabs['tab-a'] = {
      id: 'tab-a',
      sessionId: 'session-a',
      hasUnread: true,
    } as Tab
    registry.sessions['session-a'] = {
      id: 'session-a',
      run: {
        workingDirectory: '/repo',
      } as Session['run'],
    } as Session

    registry.setActiveTab('tab-a')

    expect(registry.activeTabId).toBe('tab-a')
    expect(registry.tabs['tab-a'].hasUnread).toBe(false)
  })
})
