import { describe, expect, test } from 'bun:test'
import type { Session } from '@solus/contracts/types'
import { applySessionTitleChange } from '@solus/workspace-ui/contexts/workspace/session-title-change'

function workspace() {
  return {
    sessions: {
      'local-session': { id: 'local-session', run: { serverId: 'local', taskServerId: 'local' }, agentSessionId: 'agent-1', title: 'Opening prompt', titleCustom: false } as Session,
      'remote-session': { id: 'local-session', run: { serverId: 'remote', taskServerId: 'local' }, agentSessionId: 'agent-1', title: 'Remote title', titleCustom: false } as Session,
      'other-session': { id: 'other-session', run: { serverId: 'local', taskServerId: 'local' }, agentSessionId: 'agent-2', title: 'Other title', titleCustom: false } as Session,
    },
  }
}

describe('session title changes', () => {
  test('a pending fork keeps its own name until it is a session of its own', () => {
    const state = workspace()
    const fork = {
      ...state.sessions['local-session'], id: 'fork', forked: true, title: 'My fork', titleCustom: true,
    }
    const sessions = { ...state.sessions, fork }
    for (const title of ['Renamed source', null]) {
      expect(applySessionTitleChange(sessions, 'local', {
        sessionId: 'local-session', title, source: 'manual',
      })).toEqual([{ sessionId: 'local-session', taskServerId: 'local' }])
      expect(fork.title).toBe('My fork')
      expect(fork.titleCustom).toBe(true)
    }
    fork.forked = false
    applySessionTitleChange(sessions, 'local', {
      sessionId: 'fork', title: 'Saved fork', source: 'manual',
    })
    expect(fork.title).toBe('Saved fork')
    expect(sessions['local-session'].title).toBe('New Tab')
  })

  test('names the changed session on the emitting host and no other', () => {
    // WHY: the name belongs to the session, so one write reaches every tab
    // watching it — but two hosts can hold the same session id (a dispatched
    // session), and a sibling session on this host must keep its own name.
    const state = workspace()

    expect(applySessionTitleChange(state.sessions, 'local', {
      sessionId: 'local-session',
      title: 'Generated Title',
      source: 'generated',
    })).toEqual([{ sessionId: 'local-session', taskServerId: 'local' }])
    expect(state.sessions['local-session'].title).toBe('Generated Title')
    expect(state.sessions['local-session'].titleCustom).toBe(true)
    expect(state.sessions['remote-session'].title).toBe('Remote title')
    expect(state.sessions['other-session'].title).toBe('Other title')
  })

  test('an event that names the provider thread names no session', () => {
    // WHY: one session id (docs/plans/session-identity.md). The host resolves a
    // thread to its session before it broadcasts, so a thread id never matches.
    const state = workspace()
    expect(applySessionTitleChange(state.sessions, 'local', { sessionId: 'agent-1', title: 'Wrong', source: 'manual' })).toEqual([])
    expect(state.sessions['local-session'].title).toBe('Opening prompt')
  })

  test('clearing a title restores prompt-derived display behavior', () => {
    const state = workspace()
    state.sessions['local-session'].title = 'Custom Title'
    state.sessions['local-session'].titleCustom = true

    applySessionTitleChange(state.sessions, 'local', { sessionId: 'local-session', title: null, source: 'manual' })

    expect(state.sessions['local-session'].title).toBe('New Tab')
    expect(state.sessions['local-session'].titleCustom).toBe(false)
  })

  test('identifies the task host that must receive a dispatched rename', () => {
    // WHY: the execution host owns the real session index, but the project host
    // owns the proxy row used to name closed attempts. Both need the same title.
    const state = workspace()

    expect(applySessionTitleChange(state.sessions, 'remote', {
      sessionId: 'local-session',
      title: 'Dispatched Session Name',
      source: 'generated',
      generatedDescription: 'Keep the task-host proxy in sync.',
    })).toEqual([{ sessionId: 'remote-session', taskServerId: 'local' }])
  })
})
