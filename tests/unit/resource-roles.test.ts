import { beforeEach, describe, expect, test } from 'bun:test'
import type { ResourceRole, ShareList, ShareResource } from '@solus/contracts/sharing'
import { canDriveSession, provideResourceRoles, resourceMay } from '@solus/workspace-ui/contexts/sharing/resource-roles'

// A member who has a shared session as a viewer or a commenter reads it; the
// host refuses them every editor write (admission/access-policy.ts: prompt,
// stopSession, respondPermission, setSessionTitle, ...). The client asks this
// one question before it offers any of those controls, so a reader is never
// handed a button that only fails.

const lists = new Map<string, ShareList>()
const loads: string[] = []

provideResourceRoles({
  listFor: (serverId: string, resource: ShareResource) => lists.get(`${serverId}|${resource.id}`),
  load: async (serverId: string, resource: ShareResource) => { loads.push(`${serverId}|${resource.id}`); return null },
})

function shareAs(serverId: string, sessionId: string, callerRole: ResourceRole): void {
  lists.set(`${serverId}|${sessionId}`, {
    resource: { kind: 'session', id: sessionId },
    ownerUserId: 'owner',
    grants: [],
    callerRole,
    link: null,
  })
}

beforeEach(() => {
  lists.clear()
  loads.length = 0
})

describe('resourceMay', () => {
  test('matches the host: a verb is held by the role the contracts table gives it', () => {
    // WHY (permissions.md): the client and the host read one table, so a control is
    // disabled exactly when the call would be refused.
    shareAs('host-a', 'session-1', 'viewer')
    shareAs('host-a', 'session-2', 'commenter')
    shareAs('host-a', 'session-3', 'editor')
    const session = (id: string) => ({ kind: 'session', id } as const)
    expect(resourceMay('host-a', session('session-1'), 'read')).toBe(true)
    expect(resourceMay('host-a', session('session-1'), 'drive')).toBe(false)
    // A commenter comments on works; on a session the verb never applies, so they read only.
    expect(resourceMay('host-a', session('session-2'), 'drive')).toBe(false)
    expect(resourceMay('host-a', session('session-3'), 'drive')).toBe(true)
    expect(resourceMay('host-a', session('session-3'), 'own')).toBe(false)
  })

  test('no share list means this client\'s own resource', () => {
    expect(resourceMay('host-a', { kind: 'work', id: 'mine' }, 'own')).toBe(true)
    expect(resourceMay(null, { kind: 'work', id: 'w' }, 'own')).toBe(true)
  })
})

describe('canDriveSession', () => {
  test('a viewer cannot drive the session', () => {
    shareAs('host-a', 'session-1', 'viewer')
    expect(canDriveSession('host-a', 'session-1')).toBe(false)
  })

  test('the role is per session: an editor drives the session shared to them as editor', () => {
    shareAs('host-a', 'session-1', 'viewer')
    shareAs('host-a', 'session-2', 'editor')
    expect(canDriveSession('host-a', 'session-2')).toBe(true)
  })

  test('every host shares, so a viewer on an unlinked host reads only', () => {
    // WHY: docs/plans/host-sharing.md — a host admits its own guests and members,
    // linked or not, so the share list is the authority on every host.
    shareAs('host-local', 'session-1', 'viewer')
    expect(canDriveSession('host-local', 'session-1')).toBe(false)
  })

  test('an unknown role asks the host once and drives until it answers', async () => {
    expect(canDriveSession('host-b', 'session-3')).toBe(true)
    expect(canDriveSession('host-b', 'session-3')).toBe(true)
    await Promise.resolve()
    expect(loads).toEqual(['host-b|session-3'])
  })

  test('a draft with no session or host drives', () => {
    expect(canDriveSession(null, 'session-1')).toBe(true)
    expect(canDriveSession('host-a', undefined)).toBe(true)
  })
})
