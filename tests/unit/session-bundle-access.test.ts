import { expect, test } from 'bun:test'
import { assertRpcAccess } from '@solus/server/admission/access-policy'
import type { Principal } from '@solus/server/admission/principal'

const principal: Principal = {
  kind: 'org-member', userId: 'reader', organizationId: 'org-one', organizationRole: 'member', teamIds: [],
  hostKind: 'managed', displayName: 'Reader', deviceId: 'device-one', expiresAt: Date.now() + 60_000, deviceLabel: 'Test',
}

// WHY: the repository holds full provider transcripts. A person with no
// drive.prompt standing must not get a bundle transfer id.
test('a repository bundle needs the session prompt standing', async () => {
  const args = [{ sessionId: 'session-one', have: null }]
  await expect(assertRpcAccess('sessionRepositoryBundle', principal, args, {
    standingFor: async () => ({ role: 'none' }),
  }, true)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(assertRpcAccess('sessionRepositoryBundle', principal, args, {
    standingFor: async () => ({ role: 'viewer' }),
  }, true)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(assertRpcAccess('sessionRepositoryBundle', principal, args, {
    standingFor: async () => ({ role: 'editor' }),
  }, true)).resolves.toBeUndefined()
})
