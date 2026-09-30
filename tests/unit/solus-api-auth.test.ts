import { describe, expect, test } from 'bun:test'
import { WorkspaceCredentials } from '@solus/server/admission/workspace-credentials'
import { workspaceAuthSessionRequestSchema, workspaceTaskQuerySchema } from '@solus/contracts/solus-api'
import type { Principal } from '@solus/server/admission/principal'

const member: Principal = {
  kind: 'org-member', userId: 'alice', organizationId: 'org-a', organizationRole: 'member', teamIds: [],
  hostKind: 'cloud', displayName: 'Alice', deviceId: 'device-a', deviceLabel: 'browser', expiresAt: 900_000,
}

function fixture() {
  let now = 100_000
  let revoked = false
  let spent = false
  const credentials = new WorkspaceCredentials({
    audience: 'api-a', secret: Buffer.alloc(32, 7), now: () => now,
    authenticateSource: async bearer => {
      if (bearer === 'local-source') return { principal: { kind: 'local-owner', deviceId: 'desktop', deviceLabel: 'This Mac' }, expiresAt: 900_000 }
      if (bearer !== 'cloud-source' || spent) return null
      spent = true
      return { principal: member, expiresAt: 200_000 }
    },
    isRevoked: async () => revoked,
    homeFor: principal => principal.kind === 'org-member'
      ? { kind: 'organization', serviceId: 'api-a', organizationId: principal.organizationId }
      : { kind: 'local', hostId: 'host-a' },
  })
  return { credentials, setNow: (value: number) => { now = value }, revoke: () => { revoked = true } }
}

describe('workspace request credentials', () => {
  test('cloud authority is organization bound, source-expiry bounded and cannot refresh itself', async () => {
    const { credentials, setNow } = fixture()
    const result = await credentials.exchange('cloud-source', { scopes: ['tasks:read'] })
    expect(result?.home).toEqual({ kind: 'organization', serviceId: 'api-a', organizationId: 'org-a' })
    expect(result?.expiresAt).toBe(new Date(200_000).toISOString())
    const bearer = result!.accessToken
    expect((await credentials.verify(bearer))?.scopes).toEqual(['tasks:read'])
    expect(await credentials.exchange(bearer, { scopes: ['tasks:read'] })).toBeNull()
    expect(await credentials.exchange('cloud-source', { scopes: ['tasks:read'] })).toBeNull()
    setNow(200_000)
    expect(await credentials.verify(bearer)).toBeNull()
  })

  test('local use needs no cloud authority and revocation takes effect on the next request', async () => {
    const { credentials, revoke } = fixture()
    const result = await credentials.exchange('local-source', { scopes: ['tasks:read', 'tasks:write'] })
    expect(result?.home).toEqual({ kind: 'local', hostId: 'host-a' })
    expect(await credentials.verify(result!.accessToken)).not.toBeNull()
    revoke()
    expect(await credentials.verify(result!.accessToken)).toBeNull()
  })

  test('modified tokens and organization overrides fail instead of widening context', async () => {
    const { credentials } = fixture()
    const result = await credentials.exchange('cloud-source', { scopes: ['tasks:read'] })
    const [payload, signature] = result!.accessToken.split('.')
    const changed = Buffer.from(Buffer.from(payload, 'base64url').toString().replace('org-a', 'org-b')).toString('base64url')
    expect(await credentials.verify(`${changed}.${signature}`)).toBeNull()
    expect(workspaceAuthSessionRequestSchema.safeParse({ scopes: ['tasks:read'], organizationId: 'org-b' }).success).toBe(false)
    expect(workspaceTaskQuerySchema.safeParse({ organizationId: 'org-b' }).success).toBe(false)
    expect(workspaceTaskQuerySchema.safeParse({ limit: 201 }).success).toBe(false)
  })
})
