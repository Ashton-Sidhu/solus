import { describe, expect, test } from 'bun:test'
import { SolusServer, type HandlerCtx } from '@solus/server/server/server'
import type { Principal } from '@solus/server/server/principal'
import { currentCredentialUserId, withCredentialScope } from '@solus/server/vault/credential-scope'

// docs/plans/cloud-service-model.md §22: whose GitHub, Google, or Atlassian
// connection a call acts with is decided once, at dispatch, from the principal.
// A member's call acts as that member; the host's owner and the host itself act
// with the host's own connections, which is "no scoped person".

const OWNER: Principal = { kind: 'local-owner', deviceId: null, deviceLabel: 'Mac' }
const MEMBER: Principal = { kind: 'org-member', userId: 'bob', organizationId: 'org1', organizationRole: 'member', teamIds: [], hostKind: 'managed', displayName: 'Bob', deviceId: 'd1', expiresAt: 0, deviceLabel: 'Solus cloud' }
const SYSTEM: Principal = { kind: 'system' }

function serverRecordingScope(seen: Array<string | null>): SolusServer {
  const server = new SolusServer()
  // A host-wide read: every principal here may call it.
  server.register('googleStatus', async () => {
    seen.push(currentCredentialUserId())
    // The scope must survive the handler's own awaits.
    await Promise.resolve()
    seen.push(currentCredentialUserId())
    return { connected: false, configured: false }
  })
  return server
}

const ctxFor = (principal: Principal): HandlerCtx => ({ clientId: 'test', principal })

describe('the credential scope', () => {
  test('is null outside any call, and is the person named for the duration of the call', async () => {
    expect(currentCredentialUserId()).toBeNull()
    const inside = await withCredentialScope('alice', async () => {
      await Promise.resolve()
      return currentCredentialUserId()
    })
    expect(inside).toBe('alice')
    expect(currentCredentialUserId()).toBeNull()
    // An inner scope replaces the outer one and ends with it.
    await withCredentialScope('alice', async () => {
      expect(withCredentialScope(null, () => currentCredentialUserId())).toBeNull()
      expect(currentCredentialUserId()).toBe('alice')
    })
  })

  test('a dispatch runs the handler as the calling member', async () => {
    const seen: Array<string | null> = []
    await serverRecordingScope(seen).handle('googleStatus', [], ctxFor(MEMBER))
    expect(seen).toEqual(['bob', 'bob'])
  })

  test("the host's owner and the host itself act with the host's own connections", async () => {
    // WHY: the owner's connections are the host's secret store as before; the
    // sentinel must not be looked up in a vault as if it named a person.
    const seen: Array<string | null> = []
    const server = serverRecordingScope(seen)
    await server.handle('googleStatus', [], ctxFor(OWNER))
    await server.handle('googleStatus', [], ctxFor(SYSTEM))
    expect(seen).toEqual([null, null, null, null])
  })

  test('two concurrent dispatches do not see each other', async () => {
    const seen: Array<string | null> = []
    const server = serverRecordingScope(seen)
    await Promise.all([server.handle('googleStatus', [], ctxFor(MEMBER)), server.handle('googleStatus', [], ctxFor(OWNER))])
    expect(seen.filter((userId) => userId === 'bob')).toHaveLength(2)
    expect(seen.filter((userId) => userId === null)).toHaveLength(2)
  })
})
