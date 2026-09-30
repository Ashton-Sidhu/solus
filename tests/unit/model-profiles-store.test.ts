import { afterEach, beforeEach, expect, test } from 'bun:test'
import { BUNDLED_MODEL_PROFILES, MODEL_PROFILES, replaceModelProfiles, type ModelProfiles, type ModelProfilesStatus } from '@solus/contracts/types'

declare global { var $state: <T>(value: T) => T }
const originalState = globalThis.$state
beforeEach(() => { globalThis.$state = <T>(value: T): T => value })
afterEach(() => {
  globalThis.$state = originalState
  replaceModelProfiles(BUNDLED_MODEL_PROFILES)
})

function listWith(modelId: string): ModelProfiles {
  const list = structuredClone(BUNDLED_MODEL_PROFILES)
  list['claude-code'] = {
    [modelId]: { label: modelId, reasoningLevels: ['low'], defaultReasoningEffort: 'low', supportsFastMode: false, contextWindows: [200_000], defaultContextWindow: 200_000 },
    ...list['claude-code'],
  }
  return list
}

function remote(modelId: string, fetchedAt: number): ModelProfilesStatus {
  return { source: 'remote', fetchedAt, checkedAt: fetchedAt, checking: false, error: null, profiles: listWith(modelId) }
}

async function fixture(refresh: () => Promise<ModelProfilesStatus>) {
  const { ModelProfilesStore } = await import('@solus/workspace-ui/contexts/updates/model-profiles.store.svelte')
  return new ModelProfilesStore({
    statusFor: () => 'connected', capabilitiesFor: async () => ({ modelProfiles: true }),
    apiFor: () => ({ modelProfilesStatus: refresh, modelProfilesRefresh: refresh }),
    connectedServerIds: () => [], onConnectionCreated: () => () => {}, onStatusChange: () => () => {},
  })
}

test('the newest download among connected hosts is the list the client offers', async () => {
  // WHY: every host downloads the same file, so a host that checked earlier today
  // must not take back a model another host has already brought in.
  const store = await fixture(async () => remote('unused', 0))
  store.apply('laptop', remote('model-new', 2_000))
  expect(store.revision).toBe(1)
  store.apply('server', remote('model-old', 1_000))
  expect(MODEL_PROFILES['claude-code']?.['model-new']).toBeDefined()
  expect(MODEL_PROFILES['claude-code']?.['model-old']).toBeUndefined()
  // The same list arriving again changes nothing, so no picker re-derives.
  store.apply('laptop', remote('model-new', 2_000))
  expect(store.revision).toBe(1)
})

test('a refresh the host refuses is reported on that host, and the list in effect stays', async () => {
  // WHY: the button must not look like it worked. A member without admin rights
  // gets the host's refusal, not a silent no-op.
  const store = await fixture(async () => { throw new Error('"modelProfilesRefresh" is only available to the host administrator') })
  store.apply('laptop', remote('model-new', 2_000))
  await store.refresh('laptop')
  expect(store.errors.get('laptop')).toContain('host administrator')
  expect(store.refreshing.has('laptop')).toBe(false)
  expect(MODEL_PROFILES['claude-code']?.['model-new']).toBeDefined()
})
