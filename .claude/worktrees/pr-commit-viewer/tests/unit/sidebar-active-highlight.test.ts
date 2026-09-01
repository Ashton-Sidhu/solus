import { afterEach, describe, expect, test } from 'bun:test'

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

// The sidebar marks a task active by `task.tabIds.includes(session.onScreenTabId)`.
// A draft opens in the leading pane without changing `activeTabId`, so reading it
// directly kept the tab you left behind looking like the current session. The
// gate below is what stops that: nothing on screen is a conversation, so nothing
// answers as the on-screen tab.
describe('onScreenTabId gates the sidebar active highlight', () => {
  async function makeWorkspace() {
    installRendererGlobals()
    const { WorkspaceContext } = await import('../../src/renderer/contexts/workspace/workspace.context.svelte')
    const leadingPane = { id: 'pane_1', base: { name: 'chat' } as { name: string } }
    // A companion pane holding a conversation, resolved through `chatTabIn` — the
    // same hop the real `splitChatTabId` makes.
    const asidePanes: { id: string }[] = []
    const workspace = Object.create(WorkspaceContext.prototype) as any
    workspace.registry = { activeTabId: 'tab-a' }
    workspace.router = { get leadingPane() { return leadingPane }, get asidePanes() { return asidePanes } }
    workspace.chatTabIn = (paneId: string) => (paneId === 'pane_2' ? 'tab-b' : null)
    return { workspace, leadingPane, asidePanes }
  }

  test('is the active tab while the leading pane shows a conversation', async () => {
    const { workspace } = await makeWorkspace()
    expect(workspace.showsConversation).toBe(true)
    expect(workspace.onScreenTabId).toBe('tab-a')
  })

  test('is empty while a draft owns the lead with nothing split beside it', async () => {
    const { workspace, leadingPane } = await makeWorkspace()
    leadingPane.base = { name: 'draft' }
    // The tab you left is still the active one — only its conversation is off screen.
    expect(workspace.activeTabId).toBe('tab-a')
    expect(workspace.showsConversation).toBe(false)
    expect(workspace.onScreenTabId).toBe('')
  })

  test('is the companion session while a draft owns the lead in split view', async () => {
    const { workspace, leadingPane, asidePanes } = await makeWorkspace()
    leadingPane.base = { name: 'draft' }
    asidePanes.push({ id: 'pane_2' })
    // Creating a session in one pane must not un-bold the session still on screen
    // in the other.
    expect(workspace.showsConversation).toBe(false)
    expect(workspace.onScreenTabId).toBe('tab-b')
  })
})
