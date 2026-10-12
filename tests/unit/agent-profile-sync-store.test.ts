import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type {
  AccountAgentProfilePatchRequest,
  AccountAgentProfileResponse,
  AgentProfileCopy,
  AgentProfile,
  AgentProfile,
  AgentProfileStatus,
} from '@solus/contracts/agent-profile'
import type { AgentProfileCloudRequests } from '@solus/client-core/agent-profile-requests'

/**
 * plans/020 §3, the shared desktop and web stores: the agent profile syncs
 * only after the person turns it on here; once on, every host the profile
 * applies to pulls from the account — after the first copy, and after each
 * write the account confirms (decision 8: the cloud cannot push to a host).
 * Turned off, edits stay on this device and no host is asked.
 */

let localServerId: string | null = 'laptop'
const hostCalls: string[] = []
const computer: AgentProfile = {
  'file:claude-code/CLAUDE.md': { kind: 'file', provider: 'claude-code', path: 'CLAUDE.md', contentBase64: Buffer.from('Be brief.').toString('base64'), hash: 'a'.repeat(64) },
}
const hostStatus = (entries: number, source: AgentProfileStatus['source']): AgentProfileStatus => ({
  syncedAt: entries ? 1 : null, source: entries ? source : null, revision: source === 'account' ? 3 : null,
  counts: { files: entries, skills: 0, integrations: 0 }, skipped: [],
})
mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    localServerId: () => localServerId,
    apiFor: (serverId: string) => ({
      agentProfileRead: async () => { hostCalls.push(`read:${serverId}`); return { profile: computer, skipped: [] } },
      agentProfileApply: async (request: AgentProfileCopy): Promise<AgentProfileStatus> => {
        const entries = Object.keys(request.profile).length
        hostCalls.push(`apply:${serverId}:${entries}`)
        return hostStatus(entries, 'computer')
      },
      agentProfilePull: async (): Promise<AgentProfileStatus> => { hostCalls.push(`pull:${serverId}`); return hostStatus(1, 'account') },
      agentProfileStatus: async (): Promise<AgentProfileStatus> => hostStatus(0, null),
    }),
  },
}))
mock.module('@solus/client-core/local-api', () => ({ localApi: {} }))

type Globals = Record<'window' | 'document' | 'localStorage' | 'navigator' | '$state', unknown>
const previous: Partial<Globals> = {}
const GLOBAL_KEYS = ['window', 'document', 'localStorage', 'navigator', '$state'] as const
const globals = globalThis as unknown as Globals

type MemoryStorage = Storage & { items: Map<string, string> }

function memoryStorage(): MemoryStorage {
  const items = new Map<string, string>()
  return {
    items,
    get length() { return items.size },
    key: (index: number) => [...items.keys()][index] ?? null,
    clear: () => items.clear(),
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }
}

function installDom(storage: Storage) {
  globals.window = { addEventListener() {}, removeEventListener() {} }
  globals.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' }
  globals.localStorage = storage
  globals.navigator = { onLine: true }
  globals.$state = Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => structuredClone(value) })
}

beforeEach(() => {
  for (const key of GLOBAL_KEYS) previous[key] = globals[key]
  hostCalls.length = 0
  localServerId = 'laptop'
})

afterEach(() => {
  for (const key of GLOBAL_KEYS) {
    if (previous[key] === undefined) delete globals[key]
    else globals[key] = previous[key]
  }
})

/** The account profile endpoint for one signed-in user: a compare-and-swap document, and a log of what was sent. */
function fakeAccount() {
  const sent: AccountAgentProfilePatchRequest[] = []
  const profile: AccountAgentProfileResponse = { schemaVersion: 1, generation: 0, revision: null, entries: {}, updatedAt: null }
  const requests: Pick<AgentProfileCloudRequests, 'accountAgentProfileGet' | 'accountAgentProfilePatch' | 'accountAgentProfileDelete'> = {
    accountAgentProfileGet: async () => ({ kind: 'ok', profile: structuredClone(profile) }),
    accountAgentProfilePatch: async (request) => {
      sent.push(structuredClone(request))
      if (request.expectedRevision !== profile.revision) return { kind: 'conflict', reason: 'profile_conflict', current: structuredClone(profile) }
      profile.entries = { ...profile.entries, ...request.set }
      for (const key of request.reset ?? []) delete profile.entries[key]
      profile.revision = (profile.revision ?? 0) + 1
      return { kind: 'ok', profile: structuredClone(profile) }
    },
    accountAgentProfileDelete: async () => {
      profile.generation += 1
      profile.revision = null
      profile.entries = {}
      return { kind: 'ok', profile: structuredClone(profile) }
    },
  }
  return { sent, profile, requests }
}

const quietPorts = {
  environment: { isOnline: () => true, isForeground: () => false, subscribe: () => () => {} },
  clock: { now: () => 1_000, setTimer: (callback: () => void) => { queueMicrotask(callback); return () => {} } },
  broadcast: undefined,
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

async function storesOn() {
  const storage = memoryStorage()
  installDom(storage)
  const { AgentProfileStore } = await import('@solus/workspace-ui/contexts/seats/agent-profile.store.svelte')
  const { AgentProfileLocalStore } = await import('@solus/workspace-ui/contexts/seats/agent-profile-local.store.svelte')
  const { AgentProfileSyncStore } = await import('@solus/workspace-ui/contexts/seats/agent-profile-sync.store.svelte')
  const hosts = new AgentProfileStore()
  hosts.noteHost('cloud', 'org-member')
  hosts.noteHost('vm', 'remote-owner')
  hosts.noteHost('laptop', 'local-owner')
  await settle()
  hostCalls.length = 0
  const local = new AgentProfileLocalStore(storage)
  const sync = new AgentProfileSyncStore(hosts)
  const cloud = fakeAccount()
  sync.start(local, { ...quietPorts, requests: cloud.requests, storage })
  sync.setAccount({ origin: 'https://solus.test', userId: 'user-a' })
  return { storage, hosts, local, sync, cloud }
}

const pulls = () => hostCalls.filter((call) => call.startsWith('pull:')).sort()

describe('the first copy', () => {
  test('seeding with this computer\'s profile sends it, replaces the local copy, and every applying host pulls', async () => {
    const { local, sync, cloud } = await storesOn()
    expect(sync.status.state).toBe('off')
    await sync.prepareEnable()
    expect(sync.offer?.kind).toBe('absent')
    expect(cloud.sent).toEqual([])

    await sync.enable('seed')
    expect(sync.offer).toBeNull()
    expect(sync.status.state).toBe('synced')
    expect(cloud.sent).toHaveLength(1)
    expect(cloud.sent[0].expectedRevision).toBeNull()
    expect(Object.keys(cloud.profile.entries)).toEqual(['file:claude-code/CLAUDE.md'])
    expect(Object.keys(local.entries)).toEqual(['file:claude-code/CLAUDE.md'])
    await settle()
    // WHY: the laptop is the source, never a destination; the member's seats and the owned VM pull the account's copy.
    expect(hostCalls).toContain('read:laptop')
    expect(pulls()).toEqual(['pull:cloud', 'pull:vm'])
  })

  test('on a client with no computer, the seed is this device\'s local copy', async () => {
    localServerId = null
    const { local, sync, cloud } = await storesOn()
    local.setEntry({ kind: 'skill', name: 'deploy', source: 'acme/skills', skillId: 'deploy' })
    await sync.prepareEnable()
    await sync.enable('seed')
    expect(Object.keys(cloud.profile.entries)).toEqual(['skill:deploy'])
    expect(hostCalls.filter((call) => call.startsWith('read:'))).toEqual([])
  })
})

describe('writes', () => {
  test('a confirmed write pulls every applying host; an edit while off asks no host and sends nothing', async () => {
    const { local, sync, cloud } = await storesOn()
    const entries: AgentProfile = { 'skill:deploy': { kind: 'skill', name: 'deploy', source: 'acme/skills', skillId: 'deploy' } }
    local.setEntry(entries['skill:deploy'])
    await settle()
    expect(cloud.sent).toEqual([])
    expect(pulls()).toEqual([])

    await sync.prepareEnable()
    await sync.enable('seed')
    await settle()
    hostCalls.length = 0
    local.setEntry({ kind: 'integration', slug: 'deepwiki', name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', auth: { kind: 'none' } })
    expect(sync.status.state).toBe('pending')
    await settle()
    expect(sync.status.state).toBe('synced')
    expect(cloud.profile.entries['integration:deepwiki']?.kind).toBe('integration')
    expect(pulls()).toEqual(['pull:cloud', 'pull:vm'])

    hostCalls.length = 0
    sync.turnOff()
    expect(sync.status.state).toBe('off')
    local.removeKey('integration:deepwiki')
    await settle()
    expect(local.entries['integration:deepwiki']).toBeUndefined()
    expect(cloud.profile.entries['integration:deepwiki']?.kind).toBe('integration')
    expect(pulls()).toEqual([])
  })

  test('with sync on a host pulls on first sight; with sync off this computer pushes', async () => {
    const { hosts, sync } = await storesOn()
    hosts.noteHost('new-vm', 'remote-owner')
    await settle()
    expect(hostCalls).toEqual(['read:laptop', 'apply:new-vm:1'])

    await sync.prepareEnable()
    await sync.enable('seed')
    await settle()
    hostCalls.length = 0
    hosts.noteHost('later-vm', 'remote-owner')
    await settle()
    expect(hostCalls).toEqual(['pull:later-vm'])
  })
})

describe('the local copy', () => {
  test('replacing the whole copy emits one change with only the keys that differ, and persists per account', async () => {
    const { storage, local } = await storesOn()
    const changes: unknown[] = []
    local.onLocalChange((change) => changes.push(change))
    local.setEntry({ kind: 'skill', name: 'deploy', source: 'acme/skills', skillId: 'deploy' })
    local.replaceAll({
      'skill:deploy': { kind: 'skill', name: 'deploy', source: 'acme/skills', skillId: 'deploy' },
      'skill:review': { kind: 'skill', name: 'review', source: 'acme/skills', skillId: 'review' },
    })
    local.replaceAll({ 'skill:review': { kind: 'skill', name: 'review', source: 'acme/skills', skillId: 'review' } })
    expect(changes).toEqual([
      { set: { 'skill:deploy': { kind: 'skill', name: 'deploy', source: 'acme/skills', skillId: 'deploy' } }, reset: [] },
      { set: { 'skill:review': { kind: 'skill', name: 'review', source: 'acme/skills', skillId: 'review' } }, reset: [] },
      { set: {}, reset: ['skill:deploy'] },
    ])
    expect(JSON.parse(storage.getItem('solus.agent-profile.v1:https://solus.test|user-a') ?? '{}')).toEqual(local.entries)
  })
})
