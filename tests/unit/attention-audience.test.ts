import { describe, expect, test } from 'bun:test'
import type { AttentionEntry } from '@solus/contracts/attention-types'
import { attentionVisibleTo } from '@solus/server/sharing/event-audience'
import type { Principal } from '@solus/server/admission/principal'
import type { ShareManager } from '@solus/server/sharing/share-manager'

// plans/004-shared-host-collaboration.md item 5: on a shared host, a person hears
// "needs input" only for the sessions they can open. The host owner hears all.

const BOB: Principal = { kind: 'org-member', userId: 'bob', organizationId: 'org1', organizationRole: 'member', teamIds: [], hostKind: 'managed', displayName: 'Bob', deviceId: 'd1', expiresAt: 0, deviceLabel: 'Solus cloud' }
const GUEST: Principal = { kind: 'guest', guestId: 'g1', displayName: 'Maya', deviceId: 'g1', share: { resource: { kind: 'session', id: 'shared' }, role: 'viewer', sharedByUserId: 'bob', linkSecretHash: 'h' }, expiresAt: 0, deviceLabel: 'Guest link' }
const OWNER: Principal = { kind: 'local-owner', deviceId: 'mac', deviceLabel: 'Mac' }
const RUNNER = { kind: 'runner', hostId: 'h', organizationId: 'org1' } as unknown as Principal

const shares = {
  roleFor: async (_principal: Principal, resource: { kind: string; id: string }) => (resource.id === 'shared' ? 'editor' : 'none'),
} as unknown as ShareManager

const entry = (sessionId: string): AttentionEntry => ({ sessionId, kind: 'question', since: 0, summary: '' })
const entries = [entry('shared'), entry('alices-chat')]

describe('attention audience', () => {
  test('a member and a guest see only the sessions they can open; another member\'s private session stays hidden', async () => {
    expect((await attentionVisibleTo(BOB, entries, shares)).map((e) => e.sessionId)).toEqual(['shared'])
    expect((await attentionVisibleTo(GUEST, entries, shares)).map((e) => e.sessionId)).toEqual(['shared'])
  })

  test('the host owner sees every entry; a runner sees none', async () => {
    expect(await attentionVisibleTo(OWNER, entries, shares)).toEqual(entries)
    expect(await attentionVisibleTo(RUNNER, entries, shares)).toEqual([])
  })
})
