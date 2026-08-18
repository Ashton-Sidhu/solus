import { afterEach, describe, expect, test } from 'bun:test'

const previousWindow = globalThis.window
const previousDocument = globalThis.document
const previousLocalStorage = globalThis.localStorage
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
      matchMedia: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
      solus: {},
    },
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: {
      documentElement: { classList: { toggle: () => {}, contains: () => false } },
      addEventListener: () => {},
      removeEventListener: () => {},
      visibilityState: 'visible',
    },
  })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
  })
}

afterEach(() => {
  if (previousWindow === undefined) delete (globalThis as unknown as { window?: Window }).window
  else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
  if (previousDocument === undefined) delete (globalThis as unknown as { document?: Document }).document
  else Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: previousDocument })
  if (previousLocalStorage === undefined) delete (globalThis as unknown as { localStorage?: Storage }).localStorage
  else Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: previousLocalStorage })
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
  if (previousAudio === undefined) delete (globalThis as unknown as { Audio?: typeof Audio }).Audio
  else globalThis.Audio = previousAudio
})

describe('workspace task routing', () => {
  test('can put a contextual task page beside the active conversation', async () => {
    // WHY: task links in conversation chrome must preserve the conversation
    // that gives the task context instead of replacing it in the leading pane.
    installRendererGlobals()
    const { WorkspaceContext } = await import('../../src/renderer/contexts/workspace/workspace.context.svelte')
    const navigations: unknown[] = []
    const workspace = Object.create(WorkspaceContext.prototype) as any
    workspace.tasksStore = { hostFor: () => 'host-a' }
    workspace.router = {
      leadingPane: { id: 'pane_leading' },
      navigate: (ref: unknown, options: unknown) => navigations.push({ ref, options }),
    }
    workspace.ui = { isExpanded: false }

    workspace.goToTask('task-1', 'click', 'secondary')

    expect(navigations).toEqual([{
      ref: { name: 'task', params: { taskId: 'task-1', serverId: 'host-a' } },
      options: { via: 'click', target: 'new' },
    }])
    expect(workspace.isExpanded).toBe(true)
  })

  test('keeps general task navigation in the leading pane', async () => {
    // WHY: board, palette, and task-to-task navigation remain full-page flows;
    // only the contextual breadcrumb and project-panel links request a split.
    installRendererGlobals()
    const { WorkspaceContext } = await import('../../src/renderer/contexts/workspace/workspace.context.svelte')
    const navigations: unknown[] = []
    const workspace = Object.create(WorkspaceContext.prototype) as any
    workspace.tasksStore = { hostFor: () => null }
    workspace.router = {
      leadingPane: { id: 'pane_leading' },
      navigate: (ref: unknown, options: unknown) => navigations.push({ ref, options }),
    }
    workspace.ui = { isExpanded: true }

    workspace.goToTask('task-2', 'palette')

    expect(navigations).toEqual([{
      ref: { name: 'task', params: { taskId: 'task-2', serverId: undefined } },
      options: { via: 'palette', target: 'pane_leading' },
    }])
  })
})
