import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { HostResources } from '@solus/contracts/host-resources'
import type { HostBalancePreference } from '@solus/contracts/settings'
import type { Attachment, RunConfig } from '@solus/contracts/types'
import type { SessionDraft } from '@solus/workspace-ui/contexts/workspace/session-draft.svelte'
import { adoptGit, chooseStart, folderLocation, openFolder, runHost } from '@solus/workspace-ui/contexts/workspace/run-location'

/**
 * Auto balance chooses once for a new session, and then the choice is the
 * person's: nothing moves a draft under them, and anything they pick wins
 * (docs/plans/resource-telemetry.md D7).
 */

const load = (cpuUtilization: number): HostResources => ({ sampledAt: 1, cpuUtilization, cpuCount: 8, availableMemoryBytes: 8, totalMemoryBytes: 16 })
const hostLoad = new Map<string, () => Promise<HostResources>>()
let reads = 0

mock.module('@solus/workspace-ui/contexts/connections/servers.store.svelte', () => ({
  serversStore: {
    readinessFor: () => ({ readiness: 'ready', away: false, unreachableReason: null, refusedReason: null, lastSeenAt: null }),
    executionServers: [{ id: 'a', installationId: 'a', readiness: 'ready' }, { id: 'b', installationId: 'b', readiness: 'ready' }],
  },
}))
mock.module('@solus/workspace-ui/contexts/projects/projects.store.svelte', () => ({
  projectsStore: {
    projectKeyFor: (serverId: string, path: string) => (path === '/other' ? 'other' : 'repo'),
    checkoutsOf: (key: string) => (key === 'other' ? [{ serverId: 'a', projectRoot: '/other' }, { serverId: 'b', projectRoot: '/other' }] : [{ serverId: 'b', projectRoot: '/b/repo' }]),
  },
}))
mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    connectionFor: () => undefined,
    apiFor: (serverId: string) => ({ hostResources: () => { reads += 1; return hostLoad.get(serverId)!() } }),
  },
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

function run(path = '/repo', serverId = 'a'): RunConfig {
  return {
    location: folderLocation({ serverId, path }),
    modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
    permissionMode: 'full-access',
    provider: 'claude-code',
    sessionSkills: [],
  }
}

function drafts(opts: { enabled?: boolean; preferences?: Record<string, HostBalancePreference> } = {}) {
  const pane = { id: 'lead', surfaces: [], activeSurfaceIndex: 0 }
  reads = 0
  return new SessionDrafts({
    settings: { modelOptionsByProvider: {}, activeAgent: 'claude-code', hostBalancing: { enabled: opts.enabled ?? true, preferences: opts.preferences ?? {} } },
    activeTabId: '',
    defaultRunConfig: run(),
    focusedSourceId: null,
    runFor: () => undefined,
    rootTaskIdFor: () => null,
    opening: { moveToRunOnHost: () => {} },
    refreshStartTarget: async () => {},
    router: { focusedPaneId: pane.id, panes: [pane], leadingPane: pane, storedSurfaces: [], pane: () => pane, navigate: () => {}, dropStrip: () => {}, destination: { name: 'chat' }, closeSurfacesWhere: () => {} },
  } as never)
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))
const attachment = { id: 'a1', name: 'a.png', path: '/tmp/a.png', type: 'image', mimeType: 'image/png' } as Attachment
/** What the Run on row does when a person picks it. */
async function rowAsks(store: InstanceType<typeof SessionDrafts>, draft: SessionDraft) {
  store.balance(draft, (balancer) => balancer.check(draft))
  await settled()
  await settled()
}
const bBetter = () => {
  hostLoad.set('a', async () => load(0.9))
  hostLoad.set('b', async () => load(0.1))
}

describe('Auto balance on a draft', () => {
  test('is off by default: a new session checks no host', async () => {
    bBetter()
    const store = drafts({ enabled: false })
    const draft = store.createSessionDraft({ freshTask: true })
    await settled()
    expect(reads).toBe(0)
    expect(draft.balance).toBeNull()
    expect(runHost(draft.run)).toBe('a')
  })

  test('moves a new session to the best host and keeps that choice', async () => {
    bBetter()
    const store = drafts()
    const draft = store.createSessionDraft({ freshTask: true })
    expect(draft.balance).toBe('checking')
    await settled()
    await settled()
    expect(draft.balance).toBe('chosen')
    expect(draft.run.location.checkout).toMatchObject({ serverId: 'b', path: '/b/repo' })
    const seen = reads
    // The load changes, and the choice does not.
    hostLoad.set('a', async () => load(0))
    await settled()
    expect(reads).toBe(seen)
    expect(runHost(draft.run)).toBe('b')
  })

  test('a named host, a chosen worktree, or new session in task starts no check', async () => {
    bBetter()
    const store = drafts()
    store.createSessionDraft({ freshTask: true, serverId: 'a' })
    store.createSessionDraft({ freshTask: true, worktreeRequested: true })
    store.createSessionDraft({})
    await settled()
    expect(reads).toBe(0)
  })

  test('choosing a host ends it, also while the check runs', async () => {
    let answer: (resources: HostResources) => void = () => {}
    hostLoad.set('a', async () => load(0.9))
    hostLoad.set('b', () => new Promise((resolve) => { answer = resolve }))
    const store = drafts()
    const draft = store.createSessionDraft({ freshTask: true })
    await settled()
    draft.moveTo(openFolder(draft.run.location, { serverId: 'a', path: '/elsewhere' }))
    await settled()
    expect(draft.balance).toBeNull()
    answer(load(0.1))
    await settled()
    expect(runHost(draft.run)).toBe('a')
    expect(draft.balance).toBeNull()
  })

  test('choosing a worktree ends it', async () => {
    bBetter()
    const store = drafts()
    const draft = store.createSessionDraft({ freshTask: true })
    await settled()
    draft.moveTo(chooseStart(draft.run.location, { kind: 'new-worktree' }))
    await settled()
    expect(draft.balance).toBeNull()
  })

  test('a host chosen while the first load runs is not overruled', async () => {
    bBetter()
    const store = drafts()
    const draft = store.createSessionDraft({ freshTask: true })
    draft.moveTo(openFolder(draft.run.location, { serverId: 'a', path: '/elsewhere' }))
    await settled()
    await settled()
    expect(draft.run.location.checkout).toMatchObject({ serverId: 'a', path: '/elsewhere' })
    expect(draft.balance).toBeNull()
  })

  test('another project is a new question', async () => {
    bBetter()
    const store = drafts()
    const draft = store.createSessionDraft({ freshTask: true })
    await settled()
    const seen = reads
    draft.moveTo(openFolder(draft.run.location, { serverId: 'a', path: '/other' }))
    await settled()
    expect(reads).toBeGreaterThan(seen)
  })

  test('when every host is full the draft stays, and says so', async () => {
    hostLoad.set('a', async () => load(0.99))
    hostLoad.set('b', async () => load(0.99))
    const store = drafts()
    const draft = store.createSessionDraft({ freshTask: true })
    await settled()
    expect(draft.balance).toBe('unavailable')
    expect(runHost(draft.run)).toBe('a')
  })

  test('with one eligible host there is no choice to make', async () => {
    bBetter()
    const store = drafts({ preferences: { b: 'manual' } })
    const draft = store.createSessionDraft({ freshTask: true })
    await settled()
    expect(reads).toBe(0)
    expect(draft.balance).toBeNull()
  })

  test('the Run on row checks again and drops a chosen start', async () => {
    hostLoad.set('a', async () => load(0.1))
    hostLoad.set('b', async () => load(0.9))
    const store = drafts()
    const draft = store.createSessionDraft({ freshTask: true })
    await settled()
    draft.moveTo(adoptGit(draft.run.location, { serverId: 'a', path: '/repo' }, { repoRoot: '/repo', branch: 'main', targetBranch: 'main' }))
    await settled()
    expect(draft.balance).toBe('chosen')
    draft.moveTo(chooseStart(draft.run.location, { kind: 'branch', git: { repoRoot: '/repo', branch: 'feature', targetBranch: 'main' } }))
    await settled()
    expect(draft.balance).toBeNull()
    await rowAsks(store, draft)
    expect(draft.balance).toBe('chosen')
    expect(draft.run.location.checkout).toMatchObject({ serverId: 'a', path: '/repo', git: null })
  })

  test('a check never moves a draft the person started to write', async () => {
    let answer: (resources: HostResources) => void = () => {}
    hostLoad.set('a', async () => load(0.9))
    hostLoad.set('b', () => new Promise((resolve) => { answer = resolve }))
    const store = drafts()
    const draft = store.createSessionDraft({ freshTask: true })
    await settled()
    draft.prompt.text = 'fix the login page'
    answer(load(0.1))
    await settled()
    expect(draft.run.location.checkout).toMatchObject({ serverId: 'a', path: '/repo' })
    // The check chose another host, so this one must not read as its choice.
    expect(draft.balance).toBeNull()
  })

  test('an attachment also keeps the draft where it is', async () => {
    bBetter()
    const store = drafts()
    const draft = store.createSessionDraft({ freshTask: true })
    draft.prompt.attachments = [attachment]
    await settled()
    await settled()
    expect(runHost(draft.run)).toBe('a')
    expect(draft.balance).toBeNull()
  })

  test('a written draft that is already on the best host says so honestly', async () => {
    hostLoad.set('a', async () => load(0.1))
    hostLoad.set('b', async () => load(0.9))
    const store = drafts()
    const draft = store.createSessionDraft({ freshTask: true })
    draft.prompt.text = 'fix the login page'
    await settled()
    await settled()
    expect(runHost(draft.run)).toBe('a')
    expect(draft.balance).toBe('chosen')
  })

  test('a new project with words in the draft does not move it either', async () => {
    bBetter()
    const store = drafts()
    const draft = store.createSessionDraft({ freshTask: true })
    await settled()
    await settled()
    draft.prompt.text = 'fix the login page'
    draft.moveTo(openFolder(draft.run.location, { serverId: 'b', path: '/other' }))
    hostLoad.set('a', async () => load(0.1))
    hostLoad.set('b', async () => load(0.9))
    await settled()
    await settled()
    expect(runHost(draft.run)).toBe('b')
  })

  test('the Run on row moves a written draft, because the person asked', async () => {
    let answer: (resources: HostResources) => void = () => {}
    hostLoad.set('a', async () => load(0.9))
    hostLoad.set('b', () => new Promise((resolve) => { answer = resolve }))
    const store = drafts()
    const draft = store.createSessionDraft({ freshTask: true })
    await settled()
    draft.prompt.text = 'fix the login page'
    answer(load(0.1))
    await settled()
    expect(draft.balance).toBeNull()
    bBetter()
    await rowAsks(store, draft)
    expect(draft.run.location.checkout).toMatchObject({ serverId: 'b', path: '/b/repo' })
    expect(draft.balance).toBe('chosen')
  })

  test('the Run on row cannot carry attachments, and says so', async () => {
    hostLoad.set('a', async () => load(0.1))
    hostLoad.set('b', async () => load(0.9))
    const store = drafts()
    const draft = store.createSessionDraft({ freshTask: true })
    await settled()
    await settled()
    draft.prompt.attachments = [attachment]
    bBetter()
    await rowAsks(store, draft)
    expect(runHost(draft.run)).toBe('a')
    expect(draft.balance).toBe('unavailable')
  })

  test('a draft sent or dropped while the check runs is not touched', async () => {
    let answer: (resources: HostResources) => void = () => {}
    hostLoad.set('a', async () => load(0.9))
    hostLoad.set('b', () => new Promise((resolve) => { answer = resolve }))
    const store = drafts()
    const draft = store.createSessionDraft({ freshTask: true })
    await settled()
    store.discardSessionDraft(draft.id)
    answer(load(0.1))
    await settled()
    expect(runHost(draft.run)).toBe('a')
  })
})
