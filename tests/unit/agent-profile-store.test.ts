import { expect, mock, test } from 'bun:test'
import type { AgentProfileCopy, AgentProfileStatus } from '@solus/contracts/agent-profile'

/**
 * Not signed in, the profile moves one way: read on this client's own machine,
 * written on the shared host. A client with no machine of its own copies
 * nothing, and the automatic copy happens once per host each run. With sync
 * on, a host pulls from the account instead, and this client never pushes.
 * This computer's profile fills this client's copy (the page is never blank on
 * a desktop), and a push sends that copy, so an edit on the page holds.
 */

let localServerId: string | null = 'laptop'
const calls: string[] = []
const read: AgentProfileCopy = {
  profile: {
    'file:claude-code/agents/rules.md': { kind: 'file', provider: 'claude-code', path: 'agents/rules.md', contentBase64: Buffer.from('Be brief.').toString('base64'), hash: 'a'.repeat(64) },
    'integration:deepwiki': { kind: 'integration', slug: 'deepwiki', name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', auth: { kind: 'none' } },
  },
  skipped: [],
}
const status = (entries: number, source: AgentProfileStatus['source']): AgentProfileStatus => ({
  syncedAt: entries ? 1 : null, source: entries ? source : null, revision: source === 'account' ? 3 : null,
  counts: { files: entries ? 1 : 0, skills: 0, integrations: entries ? 1 : 0 }, skipped: [],
})
mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    localServerId: () => localServerId,
    apiFor: (serverId: string) => ({
      agentProfileRead: async () => { calls.push(`read:${serverId}`); return read },
      agentProfileApply: async (request: AgentProfileCopy): Promise<AgentProfileStatus> => {
        const entries = Object.keys(request.profile).length
        calls.push(`apply:${serverId}:${entries}`)
        return status(entries, 'computer')
      },
      agentProfilePull: async (): Promise<AgentProfileStatus> => { calls.push(`pull:${serverId}`); return status(2, 'account') },
    }),
  },
}))
// The stores hold `$state` fields; outside a Svelte build the rune is a plain value.
Object.assign(globalThis, { $state: Object.assign(<T>(value: T) => value, { snapshot: <T>(value: T) => structuredClone(value) }) })
const { AgentProfileStore, profileAppliesTo } = await import('@solus/workspace-ui/contexts/seats/agent-profile.store.svelte')
const { AgentProfileLocalStore } = await import('@solus/workspace-ui/contexts/seats/agent-profile-local.store.svelte')
const { mergeComputerProfile } = await import('@solus/workspace-ui/contexts/seats/lib/agent-profile-local')

function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() { return items.size },
    key: (index: number) => [...items.keys()][index] ?? null,
    clear: () => items.clear(),
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }
}

const settle = () => new Promise((done) => setTimeout(done, 0))

test('the profile is read on this machine and written on the shared host, once per run', async () => {
  calls.length = 0
  localServerId = 'laptop'
  const store = new AgentProfileStore()
  store.noteHost('cloud', 'org-member')
  store.noteHost('cloud', 'org-member')
  await settle()
  expect(calls).toEqual(['read:laptop', 'apply:cloud:2'])
  expect(store.statuses.get('cloud')?.counts).toEqual({ files: 1, skills: 0, integrations: 1 })

  await store.remove('cloud')
  expect(calls.at(-1)).toBe('apply:cloud:0')
  expect(store.statuses.get('cloud')?.syncedAt).toBeNull()
})

test('with sync on, a host pulls from the account and this client pushes nothing', async () => {
  // WHY: the account is the distribution point once the person syncs; a push
  // from the laptop would overwrite what they edited on their phone.
  calls.length = 0
  localServerId = 'laptop'
  const store = new AgentProfileStore()
  store.setSync(true)
  store.noteHost('cloud', 'org-member')
  store.noteHost('vm', 'remote-owner')
  await settle()
  expect(calls.sort()).toEqual(['pull:cloud', 'pull:vm'])
  expect(store.statuses.get('cloud')?.source).toBe('account')

  calls.length = 0
  store.pullEverywhere()
  await settle()
  expect(calls.sort()).toEqual(['pull:cloud', 'pull:vm'])
})

test('a client with no machine of its own copies nothing, and a host never copies onto itself', async () => {
  calls.length = 0
  localServerId = null
  const store = new AgentProfileStore()
  expect(store.canCopy).toBe(false)
  store.noteHost('cloud', 'org-member')
  await store.copy('cloud')
  localServerId = 'laptop'
  await store.copy('laptop')
  expect(calls).toEqual([])
})

test('a profile applies to a member\'s seats and to a host the person owns, never to this machine or for a guest', () => {
  // WHY: a personal VM should feel like the laptop too; the laptop itself is
  // the source, and a guest has no homes of their own on the host.
  expect(profileAppliesTo('org-member', 'managed-vm', 'laptop')).toBe(true)
  expect(profileAppliesTo('remote-owner', 'personal-vm', 'laptop')).toBe(true)
  expect(profileAppliesTo('local-owner', 'paired-vm', 'laptop')).toBe(true)
  expect(profileAppliesTo('local-owner', 'laptop', 'laptop')).toBe(false)
  expect(profileAppliesTo('guest', 'managed-vm', 'laptop')).toBe(false)
  expect(profileAppliesTo(null, 'managed-vm', 'laptop')).toBe(false)
})

test('the copy never fills by itself: only an import reads this computer, and it keeps what the person added', async () => {
  // WHY: the profile is the person's list. A desktop must not fill it, or push it, until they ask.
  calls.length = 0
  localServerId = 'laptop'
  const local = new AgentProfileLocalStore(memoryStorage())
  const store = new AgentProfileStore()
  store.attachLocalCopy(local)
  store.noteHost('cloud', 'org-member')
  await settle()
  expect(calls).toEqual([])
  expect(local.entryCount).toBe(0)

  // An explicit push of an empty copy is refused with a reason, and the host is not touched.
  await store.copy('cloud')
  expect(calls).toEqual([])
  expect(store.errors.get('cloud')).toContain('empty')

  local.setEntry({ kind: 'skill', name: 'deploy', source: 'acme/skills', skillId: 'deploy' })
  await store.importComputer()
  expect(calls).toEqual(['read:laptop'])
  expect(Object.keys(local.entries).sort()).toEqual(['file:claude-code/agents/rules.md', 'integration:deepwiki', 'skill:deploy'])
  expect(store.importError).toBeNull()
})

test('a push sends this client\'s copy, so an entry removed on the page stays off the host', async () => {
  // WHY: the page is the person's list. If a push read the computer again, "Remove" would undo itself on every push.
  calls.length = 0
  localServerId = 'laptop'
  const local = new AgentProfileLocalStore(memoryStorage())
  const store = new AgentProfileStore()
  store.attachLocalCopy(local)
  await store.importComputer()
  local.removeKey('integration:deepwiki')
  calls.length = 0
  await store.copy('cloud')
  expect(calls).toEqual(['apply:cloud:1'])
})

test('merging this computer into the copy keeps the copy\'s own entries and takes the computer\'s content', () => {
  const computerFile = read.profile['file:claude-code/agents/rules.md']
  const merged = mergeComputerProfile(
    {
      'file:claude-code/agents/rules.md': { ...computerFile, contentBase64: Buffer.from('Old.').toString('base64'), hash: 'b'.repeat(64) },
      'skill:deploy': { kind: 'skill', name: 'deploy', source: 'acme/skills', skillId: 'deploy' },
    },
    read.profile,
  )
  expect(merged['file:claude-code/agents/rules.md']).toEqual(computerFile)
  expect(merged['skill:deploy']?.kind).toBe('skill')
  expect(merged['integration:deepwiki']?.kind).toBe('integration')
})
