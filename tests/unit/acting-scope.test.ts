import { describe, expect, test } from 'bun:test'
import { SolusServer, type HandlerCtx } from '@solus/server/transport/server'
import type { Principal } from '@solus/server/admission/principal'
import { currentCredentialUserId, currentIdentity, NoActingScopeError, withUserScope } from '@solus/server/vault/acting-scope'
import { installTestIdentities } from './helpers/acting-identities'

// plans/019-acting-identity.md: who a call acts as is decided once, at the edge.
// A member's call runs on their own identity with their own account
// connections; the host's owner and the host itself act as the host. Outside
// any edge there is no answer, and asking is an error, never the host.

const OWNER: Principal = { kind: 'local-owner', deviceId: null, deviceLabel: 'Mac' }
const MEMBER: Principal = { kind: 'org-member', userId: 'bob', organizationId: 'org1', organizationRole: 'member', teamIds: [], hostKind: 'managed', displayName: 'Bob', deviceId: 'd1', expiresAt: 0, deviceLabel: 'Solus cloud' }
const SYSTEM: Principal = { kind: 'system' }

installTestIdentities()

interface Seen { credentialUserId: string | null; identity: string }

function serverRecordingScope(seen: Seen[]): SolusServer {
  const server = new SolusServer()
  // A host-wide read: every principal here may call it.
  server.register('googleStatus', async () => {
    seen.push({ credentialUserId: currentCredentialUserId(), identity: currentIdentity().cacheKey })
    // The scope must survive the handler's own awaits.
    await Promise.resolve()
    seen.push({ credentialUserId: currentCredentialUserId(), identity: currentIdentity().cacheKey })
    return { connected: false, configured: false }
  })
  return server
}

const ctxFor = (principal: Principal): HandlerCtx => ({ clientId: 'test', principal })

describe('the acting scope', () => {
  test('is an error outside any call, and is the person named for the duration of the call', async () => {
    // WHY: a call that forgot to say who it acts for used to get the host's
    // credentials silently; now it fails where it was forgotten.
    expect(() => currentCredentialUserId()).toThrow(NoActingScopeError)
    expect(() => currentIdentity()).toThrow(NoActingScopeError)
    const inside = await withUserScope('alice', async () => {
      await Promise.resolve()
      return { credentialUserId: currentCredentialUserId(), identity: currentIdentity().cacheKey }
    })
    expect(inside).toEqual({ credentialUserId: 'alice', identity: 'alice' })
    expect(() => currentIdentity()).toThrow(NoActingScopeError)
    // An inner scope replaces the outer one and ends with it.
    await withUserScope('alice', async () => {
      expect(withUserScope(null, () => [currentCredentialUserId(), currentIdentity().cacheKey])).toEqual([null, 'host'])
      expect(currentCredentialUserId()).toBe('alice')
    })
  })

  test('a dispatch runs the handler as the calling member, on their own identity', async () => {
    const seen: Seen[] = []
    await serverRecordingScope(seen).handle('googleStatus', [], ctxFor(MEMBER))
    expect(seen).toEqual([{ credentialUserId: 'bob', identity: 'bob' }, { credentialUserId: 'bob', identity: 'bob' }])
  })

  test("the host's owner and the host itself act as the host", async () => {
    // WHY: the owner's connections are the host's secret store as before; the
    // sentinel must not be looked up in a vault as if it named a person.
    const seen: Seen[] = []
    const server = serverRecordingScope(seen)
    await server.handle('googleStatus', [], ctxFor(OWNER))
    await server.handle('googleStatus', [], ctxFor(SYSTEM))
    expect(seen).toEqual(Array.from({ length: 4 }, () => ({ credentialUserId: null, identity: 'host' })))
  })

  test('two concurrent dispatches do not see each other', async () => {
    const seen: Seen[] = []
    const server = serverRecordingScope(seen)
    await Promise.all([server.handle('googleStatus', [], ctxFor(MEMBER)), server.handle('googleStatus', [], ctxFor(OWNER))])
    expect(seen.filter((entry) => entry.identity === 'bob' && entry.credentialUserId === 'bob')).toHaveLength(2)
    expect(seen.filter((entry) => entry.identity === 'host' && entry.credentialUserId === null)).toHaveLength(2)
  })
})
