import { beforeEach, expect, mock, test } from 'bun:test'
import type { SessionMeta } from '@solus/contracts/types'
import { solusApiId } from '@solus/contracts/uplink'
import { folderLocation } from '@solus/workspace-ui/contexts/workspace/run-location'

// WHY: a session with no host online has one read-only surface on desktop and
// web, the tab that reads its copy in Solus Cloud. An organization session
// whose machine was not connected opened in the session record page, a second
// surface with no turn diffs. The record page is now for what the tab cannot
// show: a turn that runs on a machine this client cannot connect to, a session
// that is not in this person's list, and a client with no machine for a tab.
// The rows come from the transcript mirror, which holds each published
// organization session: the open needs no fact of a session repository.

const workspaceUi = '../../packages/workspace-ui/src'
const API = solusApiId('org-1')

interface Listed { serverId: string; homeServerId: string; runnerOffline: boolean; awayRunnerServerId?: string; sessionId: string; organizationId?: string; title: string | null; status: string; role?: string; cloudOnly?: true; opensWith: { provider: string } }
let listed: Listed | undefined
/** The facts of the session repository. An organization session with cloud sync off has none. */
let cloudHead: { head: string | null; syncedTurn: number; lastRunServerId: string | null } | null = null
let runOnHostId: string | null = 'laptop'
const rememberedRoles: Array<{ serverId: string; role: string | undefined }> = []

mock.module('@solus/client-core/server-connections', () => ({ serverConnections: { apiFor: () => ({}) } }))
mock.module(`${workspaceUi}/lib/inputFocus`, () => ({ requestInputFocus: () => {} }))
mock.module(`${workspaceUi}/contexts/hosts/hosts.svelte`, () => ({
  hosts: { hasExecution: (serverId: string) => serverId !== API, get runOn() { return runOnHostId ? { id: runOnHostId } : null } },
}))
mock.module(`${workspaceUi}/contexts/connections/servers.store.svelte`, () => ({ serversStore: { executionServers: [] } }))
mock.module(`${workspaceUi}/contexts/projects/projects.store.svelte`, () => ({
  projectsStore: { projectKeyFor: (_serverId: string, key: string) => key, checkoutsOf: () => [] },
  CHATS_GROUP_KEY: 'solus:chats',
  groupKeyFor: (_serverId: string, projectKey: string) => projectKey,
}))
mock.module(`${workspaceUi}/components/review/review-guide.store.svelte`, () => ({ reviewGuideStore: {}, sessionGuideIdentity: () => null }))
mock.module(`${workspaceUi}/lib/toasts`, () => ({ toasts: { error: () => {} } }))
mock.module(`${workspaceUi}/lib/analytics`, () => ({ track: () => {} }))
mock.module(`${workspaceUi}/contexts/workspace/session-draft.svelte`, () => ({ ownedTaskId: () => null }))
mock.module(`${workspaceUi}/contexts/sharing/resource-roles`, () => ({
  rememberRoles: (serverId: string, resources: Array<{ role?: string }>) => { rememberedRoles.push({ serverId, role: resources[0]?.role }) },
}))
mock.module(`${workspaceUi}/contexts/workspace/session-list.store.svelte`, () => ({
  sessionListStore: {
    markOpened: () => {},
    listed: (sessionId: string) => listed?.sessionId === sessionId ? listed : undefined,
    cloud: { headFor: () => cloudHead, modelOf: () => undefined },
  },
}))

const { SessionOpening } = await import(`${workspaceUi}/contexts/workspace/session-opening`)
const { RUNNER_NOT_HERE_READ_ONLY_REASON } = await import(`${workspaceUi}/contexts/workspace/machine-references`)

/** Answers every call the open makes around the parts under test. */
const ignored: unknown = new Proxy(() => {}, { get: () => ignored, apply: () => undefined })

interface FakeSession { id: string; messages: unknown[]; run: Record<string, unknown>; organizationId?: string | null; readOnlyReason?: string | null; agentSessionId?: string }

function harness() {
  const tabs: Array<{ tabId: string; serverId: string }> = []
  const sessions: Record<string, FakeSession> = {}
  const records: string[] = []
  const prepared: string[] = []
  const state = {
    tabs: {}, sessions: { byId: {} }, tabOrder: [] as string[], settings: { activeAgent: 'claude-code' },
    createTab: async (_dir: string, opts: { serverId: string }) => {
      const tabId = `tab-${tabs.length + 1}`
      tabs.push({ tabId, serverId: opts.serverId })
      sessions[tabId] = { id: tabId, messages: [], run: { location: folderLocation({ serverId: opts.serverId, path: '~' }) } }
      return tabId
    },
    sessionFor: (tabId: string) => sessions[tabId],
    openSessionRecord: (sessionId: string, serverId: string) => { records.push(`${sessionId}@${serverId}`) },
    runHosts: { opened: (tabId: string) => { prepared.push(tabId) } },
  }
  const workspace = new Proxy(state, { get: (target, key) => key in target ? target[key as keyof typeof target] : ignored })
  return { opening: new SessionOpening(workspace), tabs, sessions, records, prepared }
}

const meta: SessionMeta = {
  serverId: API, sessionId: 'session-1', provider: 'claude-code', cwd: '/repo', projectPath: '-repo',
  slug: null, firstMessage: 'Listed title', lastTimestamp: '2026-11-21T00:00:00.000Z', size: 0,
}

function organizationRow(change: Partial<Listed> = {}): Listed {
  return { serverId: API, homeServerId: API, runnerOffline: true, sessionId: 'session-1', organizationId: 'org-1', title: 'Fix the build', status: 'idle', role: 'viewer', opensWith: { provider: 'claude-code' }, ...change }
}

beforeEach(() => {
  listed = organizationRow()
  cloudHead = null
  runOnHostId = 'laptop'
  rememberedRoles.length = 0
})

test('an organization session whose machine is not on this device opens in a read-only tab that reads the cloud copy', async () => {
  // WHY: the mirror has its rows whatever its session repository says. A client
  // that waited for repository facts sent a session with cloud sync off to the
  // record page, the second surface.
  const { opening, tabs, sessions, records, prepared } = harness()

  expect(await opening.resumeSession(meta)).toBe('tab-1')

  expect(records).toEqual([])
  expect(tabs).toEqual([{ tabId: 'tab-1', serverId: 'laptop' }])
  expect(sessions['tab-1']).toMatchObject({ agentSessionId: 'session-1', organizationId: 'org-1', readOnlyReason: RUNNER_NOT_HERE_READ_ONLY_REASON })
  // The composer asks the tab's host what this reader may do: the role came with the record.
  expect(rememberedRoles).toEqual([{ serverId: 'laptop', role: 'viewer' }])
  // The Run on host has no copy of another machine's organization session: it is asked for no sync.
  expect(prepared).toEqual([])
})

test('it opens on the machine that ran it when this client keeps that machine, and is not read only', async () => {
  // WHY: that machine has the session. When it is back, its conversation takes the place of the copy.
  const cases: Array<[string, () => void]> = [
    ['the session repository names the machine', () => { cloudHead = { head: 'a'.repeat(40), syncedTurn: 3, lastRunServerId: 'studio' } }],
    ['only the record of the Solus API names the machine', () => { listed = organizationRow({ awayRunnerServerId: 'studio' }) }],
  ]
  for (const [name, arrange] of cases) {
    listed = organizationRow()
    cloudHead = null
    arrange()
    const { opening, tabs, sessions, prepared } = harness()

    expect(await opening.resumeSession(meta), name).toBe('tab-1')

    expect(tabs, name).toEqual([{ tabId: 'tab-1', serverId: 'studio' }])
    expect(sessions['tab-1'].readOnlyReason ?? null, name).toBeNull()
    expect(prepared, name).toEqual(['tab-1'])
  }
})

test('a session only the cloud lists opens on the Run on host and can continue there', async () => {
  // WHY: a personal session continues on any machine of its person. The open for an
  // organization session must not make it read only.
  listed = { ...organizationRow(), cloudOnly: true, organizationId: 'local', role: undefined }
  cloudHead = { head: 'a'.repeat(40), syncedTurn: 3, lastRunServerId: null }
  const { opening, tabs, sessions, prepared } = harness()

  expect(await opening.openCloudSession('session-1')).toBe('tab-1')

  expect(tabs).toEqual([{ tabId: 'tab-1', serverId: 'laptop' }])
  expect(sessions['tab-1'].organizationId).toBeNull()
  expect(sessions['tab-1'].readOnlyReason ?? null).toBeNull()
  expect(prepared).toEqual(['tab-1'])
})

test('the session record page shows what a tab cannot', async () => {
  // WHY: the record page stays for these three. Each other session with no host
  // online must open in the tab, or the two surfaces come back.
  const cases: Array<[string, () => void]> = [
    // That session has a host online. The record page reads the rows of the running turn as they arrive.
    ['a turn runs on a machine this client cannot connect to', () => { listed = organizationRow({ status: 'running' }) }],
    ['this client has no machine for a tab', () => { runOnHostId = null }],
    // A guest link, or a member link by address.
    ['the session is not in this person\'s list', () => { listed = undefined }],
  ]
  for (const [name, arrange] of cases) {
    listed = organizationRow()
    cloudHead = null
    runOnHostId = 'laptop'
    arrange()
    const { opening, tabs, records } = harness()

    expect(await opening.resumeSession(meta), name).toBe('')
    expect(tabs, name).toEqual([])
    expect(records, name).toEqual([`session-1@${API}`])
  }
})
