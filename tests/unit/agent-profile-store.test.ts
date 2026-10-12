import { expect, mock, test } from 'bun:test'
import type { AgentProfileCopy, AgentProfileCopy, AgentProfileStatus } from '@solus/contracts/agent-profile'

/**
 * Not signed in, the profile moves one way: read on this client's own machine,
 * written on the shared host. A client with no machine of its own copies
 * nothing, and the automatic copy happens once per host each run. With sync
 * on, a host pulls from the account instead, and this client never pushes.
 */

let localServerId: string | null = 'laptop'
const calls: string[] = []
const read: AgentProfileCopy = {
  profile: {
    'file:claude-code/CLAUDE.md': { kind: 'file', provider: 'claude-code', path: 'CLAUDE.md', contentBase64: Buffer.from('Be brief.').toString('base64'), hash: 'a'.repeat(64) },
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
const { AgentProfileStore, profileAppliesTo } = await import('@solus/workspace-ui/contexts/seats/agent-profile.store.svelte')

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
