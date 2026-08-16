import { afterEach, describe, expect, test } from 'bun:test'

const previousWindow = globalThis.window
const previousDocument = globalThis.document
const previousStateDescriptor = Object.getOwnPropertyDescriptor(globalThis, '$state')
const previousAudio = globalThis.Audio

afterEach(() => {
  if (previousWindow === undefined) {
    Reflect.deleteProperty(globalThis, 'window')
  } else {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: previousWindow,
    })
  }
  if (previousDocument === undefined) Reflect.deleteProperty(globalThis, 'document')
  else Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument })
  if (previousStateDescriptor === undefined) Reflect.deleteProperty(globalThis, '$state')
  else Object.defineProperty(globalThis, '$state', previousStateDescriptor)
  if (previousAudio === undefined) Reflect.deleteProperty(globalThis, 'Audio')
  else Object.defineProperty(globalThis, 'Audio', { configurable: true, value: previousAudio })
})

describe('clearing a conversation tab', () => {
  test('removes the tab before landing on its inherited draft', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        addEventListener: () => {},
        removeEventListener: () => {},
        matchMedia: () => ({
          matches: false,
          addEventListener: () => {},
          removeEventListener: () => {},
        }),
      },
    })
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        addEventListener: () => {},
        visibilityState: 'visible',
        documentElement: {
          classList: { contains: () => false, toggle: () => {} },
        },
      },
    })
    Object.defineProperty(globalThis, '$state', {
      configurable: true,
      value: Object.assign(<T>(value: T) => value, {
        snapshot: <T>(value: T) => value,
      }),
    })
    Object.defineProperty(globalThis, 'Audio', {
      configurable: true,
      value: class {
        currentTime = 0
        play() { return Promise.resolve() }
      },
    })
    const { WorkspaceContext } = await import(
      '../../src/renderer/contexts/workspace/workspace.context.svelte'
    )
    const calls: string[] = []
    const workspace = {
      clearTabToDraft: WorkspaceContext.prototype.clearTabToDraft,
      openSessionDraft: (options: { sourceTabId: string }) => {
        calls.push(`draft:${options.sourceTabId}`)
        return { id: 'draft-a' }
      },
      clearTab: (tabId: string) => calls.push(`clear:${tabId}`),
      closeTab: (tabId: string) => calls.push(`close:${tabId}`),
      openDraft: (draftId: string) => calls.push(`open:${draftId}`),
    }

    workspace.clearTabToDraft('tab-a', 'keybinding')

    // WHY: /clear must destroy the current conversation and tab, but the next
    // composer must be the compact draft surface with the old project context.
    expect(calls).toEqual([
      'draft:tab-a',
      'clear:tab-a',
      'close:tab-a',
      'open:draft-a',
    ])
  })
})
