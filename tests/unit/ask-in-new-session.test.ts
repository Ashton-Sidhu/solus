import { afterEach, describe, expect, test } from 'bun:test'
import type { Session, Tab } from '../../src/shared/types'
import { quotedReplyDraft } from '../../src/renderer/lib/quoted-reply'

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

describe('Ask in New Session', () => {
  test('formats every selected line as a draft quote', () => {
    expect(quotedReplyDraft(' first line \nsecond line ')).toBe(
      '> first line \n> second line\n\n',
    )
    expect(quotedReplyDraft('   ')).toBe('')
  })

  test('forks the source context into the split and leaves the question unsent', async () => {
    installRendererGlobals()
    const { WorkspaceContext } = await import(
      '../../src/renderer/contexts/workspace/workspace.context.svelte'
    )

    const sourceSession = {
      id: 'source-session',
      agentSessionId: 'agent-session',
    } as unknown as Session
    const registry = {
      activeTabId: 'source-tab',
      tabOrder: ['source-tab'],
      tabs: {
        'source-tab': { id: 'source-tab', sessionId: sourceSession.id },
      } as Record<string, Tab>,
      sessions: {
        [sourceSession.id]: sourceSession,
      } as Record<string, Session>,
    }
    let pinnedSessionId: string | null = null
    const workspace = Object.create(WorkspaceContext.prototype) as any
    workspace.registry = registry
    workspace.router = { asidePanes: [], chatSessionIn: () => null, showsChat: () => false }
    workspace.openSplitChat = (sessionId: string) => { pinnedSessionId = sessionId }
    workspace.forkTab = async (sourceTabId: string, options: { activate?: boolean }) => {
      expect(sourceTabId).toBe('source-tab')
      expect(options).toEqual({ activate: false })
      registry.tabs['fork-tab'] = { id: 'fork-tab', sessionId: 'fork-session' } as Tab
      registry.sessions['fork-session'] = {
        id: 'fork-session',
        prompt: {
          text: '',
          attachments: [],
          planRefs: [],
          workRefs: [],
          sessionRefs: [],
        },
      } as unknown as Session
      return 'fork-tab'
    }

    await workspace.askInNewSession('source-tab', 'targeted claim')

    expect(registry.activeTabId).toBe('source-tab')
    expect(pinnedSessionId).toBe('fork-session')
    expect(registry.sessions[registry.tabs['fork-tab'].sessionId].prompt.text).toBe('> targeted claim\n\n')
  })
})
