import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { asHostApi, type HostApi } from '@solus/client-core/host-api'
import type { IpcContext } from '@solus/contracts/types'

const previousDocument = globalThis.document
const previousState = (globalThis as unknown as { $state?: unknown }).$state

let isFocused = true
let visibilityState: DocumentVisibilityState = 'visible'

function ctxFor(projectPath: string): IpcContext {
  return {
    session: { projectPath, workingDirectory: projectPath },
    window: {},
    settings: {},
    statusBar: {},
  } as IpcContext
}

function recordingApi(calls: Array<[string, boolean, boolean]>): HostApi {
  return asHostApi({
    prChecksActivity: async (ctx: IpcContext, reviewSurfaceOpen: boolean, active: boolean) => {
      calls.push([ctx.session.projectPath, reviewSurfaceOpen, active])
    },
  })
}

beforeEach(() => {
  isFocused = true
  visibilityState = 'visible'
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      get visibilityState() { return visibilityState },
      hasFocus: () => isFocused,
    },
  })
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
})

afterEach(() => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument })
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

describe('PR checks activity reports', () => {
  test('reports only meaningful activity state changes', async () => {
    // WHY: focus, visibility, route, and tab effects can describe the same state.
    // The host only needs one report until the effective activity state changes.
    const calls: Array<[string, boolean, boolean]> = []
    const api = recordingApi(calls)
    const { PrChecksStore } = await import('@solus/workspace-ui/contexts/prs/pr-checks.store.svelte')
    const store = new PrChecksStore()
    const firstProject = ctxFor('/repos/first')

    store.reportActivity(api, firstProject)
    store.reportActivity(api, firstProject)
    store.setReviewSurfaceOpen(false, api, firstProject)

    store.setReviewSurfaceOpen(true, api, firstProject)
    store.setReviewSurfaceOpen(true, api, firstProject)

    isFocused = false
    store.reportActivity(api, firstProject)
    visibilityState = 'hidden'
    store.reportActivity(api, firstProject)

    store.reportActivity(api, ctxFor('/repos/second'))

    expect(calls).toEqual([
      ['/repos/first', false, true],
      ['/repos/first', true, true],
      ['/repos/first', true, false],
      ['/repos/second', true, false],
    ])
  })

  test('reports the current state again after reconnect', async () => {
    // WHY: the server forgets client activity when its transport disconnects.
    // A reconnect must restore the state even when the visible UI did not change.
    const calls: Array<[string, boolean, boolean]> = []
    const api = recordingApi(calls)
    const { PrChecksStore } = await import('@solus/workspace-ui/contexts/prs/pr-checks.store.svelte')
    const store = new PrChecksStore()
    const ctx = ctxFor('/repos/first')

    store.reportActivity(api, ctx)
    store.reportActivity(api, ctx, true)

    expect(calls).toEqual([
      ['/repos/first', false, true],
      ['/repos/first', false, true],
    ])
  })
})
