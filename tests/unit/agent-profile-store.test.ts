import { expect, mock, test } from 'bun:test'
import type { AgentProfileBundle, AgentProfileStatus } from '@solus/contracts/agent-profile'

/**
 * The profile moves one way: read on this client's own machine, written on the
 * shared host. A client with no machine of its own copies nothing, and the
 * automatic copy happens once per host each run.
 */

let localServerId: string | null = 'laptop'
const calls: string[] = []
const bundle: AgentProfileBundle = {
  files: [{ provider: 'claude-code', path: 'CLAUDE.md', contentBase64: Buffer.from('Be brief.').toString('base64') }],
  skipped: [],
}
mock.module('@solus/client-core/server-connections', () => ({
  serverConnections: {
    localServerId: () => localServerId,
    apiFor: (serverId: string) => ({
      agentProfileRead: async () => { calls.push(`read:${serverId}`); return bundle },
      agentProfileApply: async (applied: AgentProfileBundle): Promise<AgentProfileStatus> => {
        calls.push(`apply:${serverId}:${applied.files.length}`)
        return { syncedAt: applied.files.length ? 1 : null, fileCount: applied.files.length, skipped: [] }
      },
    }),
  },
}))
const { AgentProfileStore, profileAppliesTo } = await import('@solus/workspace-ui/contexts/seats/agent-profile.store.svelte')

test('the profile is read on this machine and written on the shared host, once per run', async () => {
  calls.length = 0
  localServerId = 'laptop'
  const store = new AgentProfileStore()
  store.noteHost('cloud', 'org-member')
  store.noteHost('cloud', 'org-member')
  await Promise.resolve()
  await new Promise((done) => setTimeout(done, 0))
  expect(calls).toEqual(['read:laptop', 'apply:cloud:1'])
  expect(store.statuses.get('cloud')?.fileCount).toBe(1)

  await store.remove('cloud')
  expect(calls.at(-1)).toBe('apply:cloud:0')
  expect(store.statuses.get('cloud')?.syncedAt).toBeNull()
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
