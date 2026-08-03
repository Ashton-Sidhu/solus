import { afterEach, describe, expect, test } from 'bun:test'
import type { Session, Tab } from '../../src/shared/types'

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
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
      matchMedia: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
      solus: {},
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

describe('WorkspaceContext tab closing', () => {
  test('preserves tab-order identity so unaffected strip items stay mounted', async () => {
    installRendererGlobals()

    const { WorkspaceContext } = await import('../../src/renderer/contexts/workspace/workspace.context.svelte')
    const remainingSession = {
      workingDirectory: '/repo',
      serverId: undefined,
    } as unknown as Session
    const closingSession = {
      workingDirectory: '/repo',
      serverId: undefined,
    } as unknown as Session
    const tabOrder = ['remaining-tab', 'closing-tab']
    const tabs: Record<string, Tab> = {
      'remaining-tab': { id: 'remaining-tab', sessionId: 'remaining-session' } as Tab,
      'closing-tab': { id: 'closing-tab', sessionId: 'closing-session' } as Tab,
    }
    const sessions: Record<string, Session> = {
      'remaining-session': remainingSession,
      'closing-session': closingSession,
    }
    const workspace = Object.create(WorkspaceContext.prototype) as any
    workspace.registry = {
      tabs,
      sessions,
      tabOrder,
      activeTabId: 'remaining-tab',
    }
    workspace.apiFor = () => ({ closeTab: () => {} })
    workspace.ctxFor = () => ({})
    workspace.panes = { secondaryContent: { kind: 'empty' } }
    workspace.window = { viewMode: 'pill', isWeb: false }
    workspace.config = { tabGroupMode: 'flat' }
    workspace.planStore = { plans: {} }
    workspace.lifecycle = { disposeTab: () => {} }

    workspace.closeTab('closing-tab')

    expect(workspace.tabOrder).toBe(tabOrder)
    expect(tabOrder).toEqual(['remaining-tab'])
  })
})
