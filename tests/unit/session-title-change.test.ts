import { describe, expect, test } from 'bun:test'
import type { Session, Tab } from '../../src/shared/types'
import { applySessionTitleChange } from '../../src/renderer/contexts/workspace/session-title-change'

function workspace() {
  return {
    tabs: {
      matching: { sessionId: 'local-session', title: 'Opening prompt', titleCustom: false } as Tab,
      otherHost: { sessionId: 'remote-session', title: 'Remote title', titleCustom: false } as Tab,
      otherSession: { sessionId: 'other-session', title: 'Other title', titleCustom: false } as Tab,
    },
    sessions: {
      'local-session': { serverId: 'local', agentSessionId: 'agent-1' } as Session,
      'remote-session': { serverId: 'remote', agentSessionId: 'agent-1' } as Session,
      'other-session': { serverId: 'local', agentSessionId: 'agent-2' } as Session,
    },
  }
}

describe('session title changes', () => {
  test('updates only tabs for the changed session on the emitting host', () => {
    const state = workspace()

    expect(applySessionTitleChange(state, 'local', {
      sessionId: 'agent-1',
      title: 'Generated Title',
    })).toEqual(['matching'])
    expect(state.tabs.matching.title).toBe('Generated Title')
    expect(state.tabs.matching.titleCustom).toBe(true)
    expect(state.tabs.otherHost.title).toBe('Remote title')
    expect(state.tabs.otherSession.title).toBe('Other title')
  })

  test('clearing a title restores prompt-derived display behavior', () => {
    const state = workspace()
    state.tabs.matching.title = 'Custom Title'
    state.tabs.matching.titleCustom = true

    applySessionTitleChange(state, 'local', { sessionId: 'agent-1', title: null })

    expect(state.tabs.matching.title).toBe('New Tab')
    expect(state.tabs.matching.titleCustom).toBe(false)
  })
})
