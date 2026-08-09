import { describe, expect, test } from 'bun:test'
import type { Session } from '../../src/shared/types'
import { applySessionTitleChange } from '../../src/renderer/contexts/workspace/session-title-change'

function workspace() {
  return {
    sessions: {
      'local-session': { run: { serverId: 'local' }, agentSessionId: 'agent-1', title: 'Opening prompt', titleCustom: false } as Session,
      'remote-session': { run: { serverId: 'remote' }, agentSessionId: 'agent-1', title: 'Remote title', titleCustom: false } as Session,
      'other-session': { run: { serverId: 'local' }, agentSessionId: 'agent-2', title: 'Other title', titleCustom: false } as Session,
    },
  }
}

describe('session title changes', () => {
  test('names the changed session on the emitting host and no other', () => {
    // WHY: the name belongs to the conversation, so one write reaches every tab
    // watching it — but two hosts can issue the same agent session id, and a
    // sibling session on this host must keep its own name.
    const state = workspace()

    expect(applySessionTitleChange(state, 'local', {
      sessionId: 'agent-1',
      title: 'Generated Title',
    })).toEqual(['local-session'])
    expect(state.sessions['local-session'].title).toBe('Generated Title')
    expect(state.sessions['local-session'].titleCustom).toBe(true)
    expect(state.sessions['remote-session'].title).toBe('Remote title')
    expect(state.sessions['other-session'].title).toBe('Other title')
  })

  test('clearing a title restores prompt-derived display behavior', () => {
    const state = workspace()
    state.sessions['local-session'].title = 'Custom Title'
    state.sessions['local-session'].titleCustom = true

    applySessionTitleChange(state, 'local', { sessionId: 'agent-1', title: null })

    expect(state.sessions['local-session'].title).toBe('New Tab')
    expect(state.sessions['local-session'].titleCustom).toBe(false)
  })
})
