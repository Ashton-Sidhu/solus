import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type {
  AccountAgentProfilePatchRequest,
  AccountAgentProfileResponse,
  AgentProfileCopy,
  AgentProfile,
  AgentProfileStatus,
} from '@solus/contracts/agent-profile'
import type { AgentProfileCloudRequests } from '@solus/client-core/agent-profile-requests'
import type { SettingsCloudRequests } from '@solus/client-core/settings-requests'
import type { AccountSettingsPatchRequest, AccountSettingsResponse, PersonalSettingsDocument } from '@solus/contracts/settings'

/**
 * plans/018 decision 9 and plans/020 §10, the shared desktop and web store:
 * one owner for the account's two synced documents. Signed in is synced:
 * signing in starts each document with no choice to make — the account's copy
 * when it has one, else this device's (this computer's profile on the desktop)
 * — and there is no way to turn it off on one device. The profile's hosts pull
 * from the account after the first copy and after each confirmed write
 * (plans/020 decision 8: the cloud cannot push to a host). Signed out, edits
 * stay on this device and this computer pushes.
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
  const style = { setProperty() {} }
  globals.window = { addEventListener() {}, removeEventListener() {} }
  globals.document = {
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
    documentElement: { classList: { toggle() {}, contains: () => false }, style },
    body: { style },
    querySelectorAll: () => [],
    querySelector: () => null,
  }
  globals.localStorage = storage
  globals.navigator = { userAgent: 'Macintosh', platform: 'MacIntel', onLine: true }
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
function fakeAccount(entries: AgentProfile | null = null) {
  const sent: AccountAgentProfilePatchRequest[] = []
  const profile: AccountAgentProfileResponse = entries
    ? { schemaVersion: 1, generation: 0, revision: 7, entries: structuredClone(entries), updatedAt: 500 }
    : { schemaVersion: 1, generation: 0, revision: null, entries: {}, updatedAt: null }
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

/** The account settings endpoint, the same way. */
function fakeSettingsAccount(settings: PersonalSettingsDocument | null = null) {
  const sent: AccountSettingsPatchRequest[] = []
  const document: AccountSettingsResponse = settings
    ? { schemaVersion: 1, generation: 0, revision: 2, settings: structuredClone(settings), updatedAt: 400 }
    : { schemaVersion: 1, generation: 0, revision: null, settings: {}, updatedAt: null }
  const requests: Pick<SettingsCloudRequests, 'accountSettingsGet' | 'accountSettingsPatch' | 'accountSettingsDelete'> = {
    accountSettingsGet: async () => ({ kind: 'ok', settings: structuredClone(document) }),
    accountSettingsPatch: async (request) => {
      sent.push(structuredClone(request))
      if (request.expectedRevision !== document.revision) return { kind: 'conflict', reason: 'settings_conflict', current: structuredClone(document) }
      document.settings = { ...document.settings, ...request.set }
      for (const key of request.reset ?? []) delete document.settings[key]
      document.revision = (document.revision ?? 0) + 1
      return { kind: 'ok', settings: structuredClone(document) }
    },
    accountSettingsDelete: async () => {
      document.generation += 1
      document.revision = null
      document.settings = {}
      return { kind: 'ok', settings: structuredClone(document) }
    },
  }
  return { sent, document, requests }
}

const quietPorts = {
  environment: { isOnline: () => true, isForeground: () => false, subscribe: () => () => {} },
  clock: { now: () => 1_000, setTimer: (callback: () => void) => { queueMicrotask(callback); return () => {} } },
  broadcast: () => undefined,
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

/** The stores, signed out: a sign-in is `signIn()`, and its start has settled when it returns. */
async function storesOn(options: { account?: AgentProfile; anonymous?: AgentProfile; settings?: PersonalSettingsDocument } = {}) {
  const storage = memoryStorage()
  installDom(storage)
  const { AgentProfileStore } = await import('@solus/workspace-ui/contexts/seats/agent-profile.store.svelte')
  const { AgentProfileLocalStore } = await import('@solus/workspace-ui/contexts/seats/agent-profile-local.store.svelte')
  const { PersonalSettingsStore } = await import('@solus/workspace-ui/contexts/app/personal-settings.store.svelte')
  const { AccountSyncStore } = await import('@solus/workspace-ui/contexts/account/account-sync.store.svelte')
  const hosts = new AgentProfileStore()
  hosts.noteHost('cloud', 'org-member')
  hosts.noteHost('vm', 'remote-owner')
  hosts.noteHost('laptop', 'local-owner')
  await settle()
  hostCalls.length = 0
  const local = new AgentProfileLocalStore(storage)
  if (options.anonymous) local.replaceAll(options.anonymous)
  const personal = new PersonalSettingsStore(storage)
  const sync = new AccountSyncStore(hosts)
  const cloud = fakeAccount(options.account)
  const settingsCloud = fakeSettingsAccount(options.settings)
  sync.start(personal, local, { ...quietPorts, settingsRequests: settingsCloud.requests, profileRequests: cloud.requests, storage })
  sync.setAccount(null)
  const signIn = async () => {
    sync.setAccount({ origin: 'https://solus.test', userId: 'user-a' })
    await settle()
  }
  return { storage, hosts, local, personal, sync, cloud, settingsCloud, signIn }
}

const pulls = () => hostCalls.filter((call) => call.startsWith('pull:')).sort()

describe('signing in', () => {
  test('with nothing in the account, sync starts with this computer\'s profile as the first copy, and every applying host pulls', async () => {
    const { local, sync, cloud, signIn } = await storesOn()
    expect(sync.state).toBe('signed-out')
    expect(cloud.sent).toEqual([])

    await signIn()
    expect(sync.profile.state).toBe('synced')
    expect(sync.state).toBe('synced')
    expect(sync.notice).toBeNull()
    expect(cloud.sent).toHaveLength(1)
    // WHY: a seed creates the document only where none exists, so a device that signs in never overwrites another's copy.
    expect(cloud.sent[0].expectedRevision).toBeNull()
    expect(Object.keys(cloud.profile.entries)).toEqual(['file:claude-code/CLAUDE.md'])
    expect(Object.keys(local.entries)).toEqual(['file:claude-code/CLAUDE.md'])
    // WHY: the laptop is the source, never a destination; the member's seats and the owned VM pull the account's copy.
    expect(hostCalls).toContain('read:laptop')
    expect(pulls()).toEqual(['pull:cloud', 'pull:vm'])
  })

  test('on a client with no computer, the first copy is this device\'s local copy', async () => {
    localServerId = null
    const deploy: AgentProfile = { 'skill:deploy': { kind: 'skill', name: 'deploy', source: 'acme/skills', skillId: 'deploy' } }
    const { sync, cloud, signIn } = await storesOn({ anonymous: deploy })
    await signIn()
    expect(sync.profile.state).toBe('synced')
    expect(Object.keys(cloud.profile.entries)).toEqual(['skill:deploy'])
    expect(hostCalls.filter((call) => call.startsWith('read:'))).toEqual([])
  })

  test('with a profile in the account, this device takes it: nothing is sent and every applying host pulls', async () => {
    const synced: AgentProfile = { 'integration:deepwiki': { kind: 'integration', slug: 'deepwiki', name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', auth: { kind: 'none' } } }
    const { local, sync, cloud, signIn } = await storesOn({ account: synced })
    await signIn()
    expect(sync.profile.state).toBe('synced')
    expect(cloud.sent).toEqual([])
    // WHY: the account is the one copy; this computer's profile does not replace it on sign-in.
    expect(local.entries['integration:deepwiki']?.kind).toBe('integration')
    expect(hostCalls.filter((call) => call.startsWith('read:'))).toEqual([])
    expect(pulls()).toEqual(['pull:cloud', 'pull:vm'])
  })

  test('the settings start the same way, and the account shows the worse of the two states', async () => {
    const { personal, sync, settingsCloud, signIn } = await storesOn({ settings: { themeMode: 'dark' } })
    personal.set('fontSize', 17)
    await signIn()
    // The account wins: its theme arrives, and the edit made signed out goes.
    expect(settingsCloud.sent).toEqual([])
    expect(personal.storedDocument).toEqual({ themeMode: 'dark' })
    expect(sync.settings.state).toBe('synced')
    expect(sync.state).toBe('synced')
    expect(sync.lastSyncedAt).toBe(1_000)

    personal.set('fontSize', 18)
    expect(sync.settings.state).toBe('pending')
    expect(sync.state).toBe('pending')
    expect(sync.pendingCount).toBe(1)
    await settle()
    expect(settingsCloud.document.settings).toEqual({ themeMode: 'dark', fontSize: 18 })
    expect(sync.state).toBe('synced')
  })

  test('there is no way to turn sync off on one device', async () => {
    installDom(memoryStorage())
    const { AccountSyncStore } = await import('@solus/workspace-ui/contexts/account/account-sync.store.svelte')
    const methods = Object.getOwnPropertyNames(AccountSyncStore.prototype)
    expect(methods).not.toContain('turnOff')
    expect(methods).not.toContain('enable')
    expect(methods).not.toContain('beginEnable')
    expect(methods).not.toContain('choose')
  })

  test('a failed start shows its error and is tried again on refresh', async () => {
    const { sync, cloud, signIn } = await storesOn()
    const get = cloud.requests.accountAgentProfileGet
    cloud.requests.accountAgentProfileGet = async () => ({ kind: 'error', code: 'unavailable', message: 'Account is down.' })
    await signIn()
    expect(sync.profile.state).toBe('error')
    expect(sync.profile.error).toEqual({ code: 'unavailable', message: 'Account is down.' })
    expect(sync.state).toBe('error')
    expect(cloud.sent).toEqual([])

    cloud.requests.accountAgentProfileGet = get
    sync.refresh()
    await settle()
    expect(sync.profile.state).toBe('synced')
    expect(sync.state).toBe('synced')
    expect(Object.keys(cloud.profile.entries)).toEqual(['file:claude-code/CLAUDE.md'])
  })
})

describe('writes', () => {
  test('a confirmed write pulls every applying host; signed out, an edit asks no host and sends nothing', async () => {
    const { local, sync, cloud, signIn } = await storesOn()
    local.setEntry({ kind: 'skill', name: 'deploy', source: 'acme/skills', skillId: 'deploy' })
    await settle()
    expect(cloud.sent).toEqual([])
    expect(pulls()).toEqual([])

    await signIn()
    hostCalls.length = 0
    local.setEntry({ kind: 'integration', slug: 'deepwiki', name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', auth: { kind: 'none' } })
    expect(sync.profile.state).toBe('pending')
    await settle()
    expect(sync.profile.state).toBe('synced')
    expect(cloud.profile.entries['integration:deepwiki']?.kind).toBe('integration')
    expect(pulls()).toEqual(['pull:cloud', 'pull:vm'])
  })

  test('disabling an entry sends it with the flag, and every host pulls; enabling sends it without', async () => {
    const { local, cloud, signIn } = await storesOn()
    await signIn()
    hostCalls.length = 0
    const { entriesWithDisabled } = await import('@solus/workspace-ui/components/settings/agent-profile/lib/agent-profile-entries')
    local.setEntry(...entriesWithDisabled(local.storedEntries, ['file:claude-code/CLAUDE.md'], true))
    await settle()
    // WHY: a disabled entry stays in the profile, so the person can turn it on again; only the hosts drop it.
    expect(cloud.profile.entries['file:claude-code/CLAUDE.md']).toMatchObject({ path: 'CLAUDE.md', disabled: true })
    expect(pulls()).toEqual(['pull:cloud', 'pull:vm'])

    local.setEntry(...entriesWithDisabled(local.storedEntries, ['file:claude-code/CLAUDE.md'], false))
    await settle()
    expect(cloud.profile.entries['file:claude-code/CLAUDE.md']).toEqual(computer['file:claude-code/CLAUDE.md'])
  })

  test('signed in a host pulls on first sight; signed out this computer pushes', async () => {
    const { hosts, signIn } = await storesOn()
    hosts.noteHost('new-vm', 'remote-owner')
    await settle()
    expect(hostCalls).toEqual(['read:laptop', 'apply:new-vm:1'])

    await signIn()
    hostCalls.length = 0
    hosts.noteHost('later-vm', 'remote-owner')
    await settle()
    expect(hostCalls).toEqual(['pull:later-vm'])
  })
})

describe('clearing', () => {
  test('clearing the synced profile starts it again from this device', async () => {
    const synced: AgentProfile = { 'skill:deploy': { kind: 'skill', name: 'deploy', source: 'acme/skills', skillId: 'deploy' } }
    const { sync, cloud, signIn } = await storesOn({ account: synced })
    await signIn()
    hostCalls.length = 0
    await sync.clearProfile()
    await settle()
    expect(sync.profile.state).toBe('synced')
    expect(sync.notice).toEqual({ document: 'profile', kind: 'cleared' })
    expect(cloud.profile.generation).toBe(1)
    expect(Object.keys(cloud.profile.entries)).toEqual(['file:claude-code/CLAUDE.md'])
    // The hosts read the new copy now.
    expect(pulls()).toEqual(['pull:cloud', 'pull:vm'])
  })

  test('clearing the synced settings is its own reset: the profile is left alone', async () => {
    const { sync, cloud, settingsCloud, personal, signIn } = await storesOn({ settings: { themeMode: 'light' } })
    await signIn()
    personal.set('themeMode', 'dark')
    await settle()
    await sync.clearSettings()
    await settle()
    expect(sync.notice).toEqual({ document: 'settings', kind: 'cleared' })
    expect(settingsCloud.document).toMatchObject({ generation: 1, revision: 1, settings: { themeMode: 'dark' } })
    expect(cloud.profile.generation).toBe(0)
    expect(sync.state).toBe('synced')
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
    expect(JSON.parse(storage.getItem('solus.agent-profile.v1:anonymous') ?? '{}')).toEqual(local.entries)
  })

  test('disabling records one change with the same entry flagged, enabling one without, and a hand-written skill\'s files move together', async () => {
    const { local } = await storesOn()
    const { entriesWithDisabled, sectionsOf } = await import('@solus/workspace-ui/components/settings/agent-profile/lib/agent-profile-entries')
    const skillFile = (provider: 'claude-code' | 'codex', path: string) => ({ kind: 'file' as const, provider, path, contentBase64: 'IyBSZXZpZXc=', hash: 'b'.repeat(64) })
    local.setEntry(skillFile('claude-code', 'skills/review/SKILL.md'), skillFile('codex', 'skills/review/SKILL.md'))
    const changes: unknown[] = []
    local.onLocalChange((change) => changes.push(change))
    const [skill] = sectionsOf(local.entries).writtenSkills

    local.setEntry(...entriesWithDisabled(local.storedEntries, skill.keys, true))
    expect(changes).toEqual([{
      set: {
        'file:claude-code/skills/review/SKILL.md': { ...skillFile('claude-code', 'skills/review/SKILL.md'), disabled: true },
        'file:codex/skills/review/SKILL.md': { ...skillFile('codex', 'skills/review/SKILL.md'), disabled: true },
      },
      reset: [],
    }])
    expect(sectionsOf(local.entries).writtenSkills[0].disabled).toBe(true)

    local.setEntry(...entriesWithDisabled(local.storedEntries, skill.keys, false))
    expect(changes[1]).toEqual({
      set: {
        'file:claude-code/skills/review/SKILL.md': skillFile('claude-code', 'skills/review/SKILL.md'),
        'file:codex/skills/review/SKILL.md': skillFile('codex', 'skills/review/SKILL.md'),
      },
      reset: [],
    })
    expect(changes).toHaveLength(2)
    expect(sectionsOf(local.entries).writtenSkills[0].disabled).toBe(false)
  })
})
