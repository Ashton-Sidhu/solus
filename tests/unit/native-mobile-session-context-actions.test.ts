import { describe, expect, test } from 'bun:test'
import { SESSION_CONTEXT_ACTIONS, sessionContextDestination } from '../../apps/mobile/src/features/threads/session-context-actions'

const session = { hostId: 'remote-host', sessionId: 'session-a', projectPath: '/remote/project' }

describe('session row tool destinations', () => {
  test('each tool opens the selected session on its own host', () => {
    expect(sessionContextDestination('open-browser', session)).toEqual(['ThreadBrowserPreview', { hostId: 'remote-host', sessionId: 'session-a' }])
    expect(sessionContextDestination('open-devices', session)).toEqual(['Devices', { hostId: 'remote-host', sessionId: 'session-a' }])
    expect(sessionContextDestination('open-artifacts', session)).toEqual(['ThreadArtifacts', { hostId: 'remote-host', sessionId: 'session-a' }])
  })

  test('new sessions keep their host and project, while chat sessions have no project', () => {
    expect(sessionContextDestination('new-session', session)).toEqual(['NewTask', { hostId: 'remote-host', projectPath: '/remote/project' }])
    expect(sessionContextDestination('new-session', { ...session, projectPath: null })).toEqual(['NewTask', { hostId: 'remote-host' }])
  })

  test('pull requests open the host tab, and lifecycle actions keep their existing handler', () => {
    expect(sessionContextDestination('open-pull-requests', session)).toEqual(['Home', { tab: 'pullRequests', hostId: 'remote-host' }])
    for (const action of ['settle', 'unsettle', 'archive', 'rename', 'mark-unread', 'unknown']) {
      expect(sessionContextDestination(action, session)).toBeNull()
    }
  })

  test('Solus tools form one submenu rather than separate header buttons', () => {
    const tools = SESSION_CONTEXT_ACTIONS.find((action) => action.id === 'session-tools')
    expect(tools?.subactions?.map((action) => action.id)).toEqual(['open-browser', 'open-devices', 'open-artifacts'])
  })
})
