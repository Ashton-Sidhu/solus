import { describe, expect, test } from 'bun:test'
import {
  prLinkDiscoveryKey,
  type PrLinkDiscoveryInput,
} from '@solus/workspace-ui/contexts/workspace/pr-link-discovery'

function input(overrides: Partial<PrLinkDiscoveryInput> = {}): PrLinkDiscoveryInput {
  return {
    taskId: 'task-1',
    serverId: 'host-a',
    projectKey: '/repo',
    prNumber: null,
    branches: ['feature'],
    originSessionId: 'session-1',
    ...overrides,
  }
}

describe('prLinkDiscoveryKey', () => {
  test('is stable when task order changes', () => {
    // WHY: sidebar lifecycle updates can reorder rows. The same discovery
    // inputs must not start another host request.
    const first = input()
    const second = input({ taskId: 'task-2', branches: ['other'] })
    expect(prLinkDiscoveryKey([first, second])).toBe(prLinkDiscoveryKey([second, first]))
  })

  test('changes when a branch changes', () => {
    expect(prLinkDiscoveryKey([input({ branches: ['main'] })]))
      .not.toBe(prLinkDiscoveryKey([input({ branches: ['feature'] })]))
  })

  test('changes when the linked PR changes', () => {
    expect(prLinkDiscoveryKey([input({ prNumber: null })]))
      .not.toBe(prLinkDiscoveryKey([input({ prNumber: 42 })]))
  })
})
