import { afterEach, describe, expect, test } from 'bun:test'
import type { Session, Tab } from '../../src/shared/types'
import { hasSessionStarted } from '../../src/renderer/lib/sessionUtils'

const previousWindow = globalThis.window
const previousState = (globalThis as unknown as { $state?: unknown }).$state
const previousAudio = globalThis.Audio

function installRendererGlobals(): void {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
  globalThis.Audio = class {
    currentTime = 0
    play() { return Promise.resolve() }
  } as unknown as typeof Audio
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      dispatchEvent: () => true,
      addEventListener: () => {},
      removeEventListener: () => {},
      matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
      solus: { getPlatform: () => 'desktop' },
    },
  })
}

afterEach(() => {
  if (previousWindow === undefined) delete (globalThis as unknown as { window?: Window }).window
  else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
  if (previousAudio === undefined) delete (globalThis as unknown as { Audio?: typeof Audio }).Audio
  else globalThis.Audio = previousAudio
})

describe('resuming a session into an empty composer', () => {
  test('leaves the tab in the order it was already in, and stops it being a draft', async () => {
    installRendererGlobals()
    const { WorkspaceContext } = await import('../../src/renderer/contexts/workspace/workspace.context.svelte')

    const draftSession = {
      id: 'draft-session',
      agentSessionId: null,
      run: {
        serverId: 'local',
        provider: 'claude-code',
        workingDirectory: '/repo',
        gitContext: null,
      } as Session['run'],
      status: 'idle',
      messages: [],
    } as unknown as Session
    const draftTab = { id: 'draft-tab', sessionId: draftSession.id, title: '', titleCustom: false } as Tab
    const registry = {
      tabs: { [draftTab.id]: draftTab } as Record<string, Tab>,
      sessions: { [draftSession.id]: draftSession } as Record<string, Session>,
      // A composer is an ordinary tab: in the order from the moment it exists.
      tabOrder: [draftTab.id],
      activeTabId: draftTab.id,
      get activeTab() { return this.tabs[this.activeTabId] },
      get activeSession() { return this.sessions[this.tabs[this.activeTabId]?.sessionId] },
    }

    const workspace = Object.create(WorkspaceContext.prototype) as any
    workspace.registry = registry
    workspace.lifecycle = { staticInfo: { homePath: '/home' } }
    workspace.ui = { isExpanded: false }
    workspace.settings = { activeAgent: 'claude-code', update: () => {} }
    workspace.eventReducer = { rebuildAgentConversations: () => {} }
    workspace.resetOverlays = () => {}
    workspace.setActiveTab = (tabId: string) => { registry.activeTabId = tabId }
    // Everything past the takeover is transcript loading, which this test lets
    // reject: the state it asserts is settled before the first await.
    workspace.apiFor = () => { throw new Error('transcript load not exercised') }

    void (workspace.resumeSession({ sessionId: 'agent-session', cwd: '/repo' }) as Promise<string>)
      .catch(() => null)

    // WHY: the conversation pool renders the tabs in `tabOrder`, and a tab
    // showing the new-tab home is the same tab that will show the transcript.
    // Resuming therefore has nothing to register, promote or hand over — which
    // is what stops this path from silently rendering an empty column when it
    // forgets a step that no longer exists.
    expect(registry.tabOrder).toEqual([draftTab.id])
    expect(draftSession.agentSessionId).toBe('agent-session')
    expect(hasSessionStarted(workspace.sessionFor(draftTab.id))).toBe(true)
  })
})
