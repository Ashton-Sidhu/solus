import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { RunConfig } from '@solus/contracts/types'
import { folderLocation, runHost } from '@solus/workspace-ui/contexts/workspace/run-location'

/**
 * Auto balance is off by default, so its code loads at the first check and not
 * with the workspace. A chunk can fail to load on a bad network: the draft then
 * stays on its host, and says that Auto balance is unavailable.
 */

let loads = 0
let failLoad = true

// A rejection on the load path: `import()` and building the balancer are one promise.
mock.module('@solus/workspace-ui/contexts/workspace/draft-balancer', () => ({
  DraftBalancer: class {
    constructor() {
      loads += 1
      if (failLoad) throw new Error('chunk failed')
    }

    async check(draft: { balance: string }) { draft.balance = 'chosen' }
  },
}))
mock.module('@solus/workspace-ui/contexts/connections/servers.store.svelte', () => ({
  serversStore: { readinessFor: () => ({ readiness: 'ready', away: false, unreachableReason: null, refusedReason: null, lastSeenAt: null }) },
}))
mock.module('@solus/workspace-ui/lib/git-actions.svelte', () => ({ disposeGitActions: () => {} }))
mock.module('svelte-sonner', () => ({ toast: Object.assign(() => '', { success: () => '', error: () => '', dismiss: () => {} }) }))

const previousState = (globalThis as unknown as { $state?: unknown }).$state
let SessionDrafts: typeof import('@solus/workspace-ui/contexts/workspace/session-drafts.svelte')['SessionDrafts']

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => value })
  ;({ SessionDrafts } = await import('@solus/workspace-ui/contexts/workspace/session-drafts.svelte'))
})

afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
  mock.restore()
})

function run(): RunConfig {
  return {
    location: folderLocation({ serverId: 'a', path: '/repo' }),
    modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
    permissionMode: 'full-access',
    provider: 'claude-code',
    sessionSkills: [],
  }
}

function drafts(enabled: boolean) {
  const pane = { id: 'lead', surfaces: [], activeSurfaceIndex: 0 }
  return new SessionDrafts({
    settings: { modelOptionsByProvider: {}, activeAgent: 'claude-code', hostBalancing: { enabled, preferences: {} } },
    activeTabId: '',
    defaultRunConfig: run(),
    focusedSourceId: null,
    runFor: () => undefined,
    rootTaskIdFor: () => null,
    opening: { moveToRunOnHost: () => {} },
    refreshStartTarget: async () => {},
    router: { focusedPaneId: pane.id, panes: [pane], leadingPane: pane, storedSurfaces: [], pane: () => pane, navigate: () => {}, dropStrip: () => {} },
  } as never)
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('loading Auto balance', () => {
  test('a person with it off never loads it', async () => {
    const draft = drafts(false).createSessionDraft({ freshTask: true })
    await settled()
    expect(loads).toBe(0)
    expect(draft.balance).toBeNull()
  })

  test('a failed load leaves the draft on its host and says Auto balance is unavailable', async () => {
    const store = drafts(true)
    const draft = store.createSessionDraft({ freshTask: true })
    await settled()
    expect(loads).toBeGreaterThan(0)
    expect(draft.balance).toBe('unavailable')
    expect(runHost(draft.run)).toBe('a')
  })

  test('the next check tries the load again', async () => {
    const store = drafts(true)
    store.createSessionDraft({ freshTask: true })
    await settled()
    failLoad = false
    const draft = store.createSessionDraft({ freshTask: true })
    await settled()
    expect(draft.balance).toBe('chosen')
  })
})
