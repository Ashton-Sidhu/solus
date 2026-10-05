import { beforeEach, describe, expect, test } from 'bun:test'
import type { ResourceRole, ShareList, ShareResource } from '@solus/contracts/sharing'
import { canDriveSession, provideShareRoles, roleCanDrive } from '@solus/workspace-ui/contexts/sharing/session-drive'

// A member who has a shared session as a viewer or a commenter reads it; the
// host refuses them every editor write (admission/access-policy.ts: prompt,
// stopSession, respondPermission, setSessionTitle, ...). The client asks this
// one question before it offers any of those controls, so a reader is never
// handed a button that only fails.

const lists = new Map<string, ShareList>()
const linkedHosts = new Set<string>()
const loads: string[] = []

provideShareRoles({
  isHostLinked: (serverId: string) => linkedHosts.has(serverId),
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
  linkedHosts.clear()
  loads.length = 0
})

describe('roleCanDrive', () => {
  test('matches the host: only an editor or the owner drives a session', () => {
    expect(roleCanDrive('owner')).toBe(true)
    expect(roleCanDrive('editor')).toBe(true)
    // A commenter comments on works; on a session the host treats them as a viewer.
    expect(roleCanDrive('commenter')).toBe(false)
    expect(roleCanDrive('viewer')).toBe(false)
    expect(roleCanDrive('none')).toBe(false)
  })

  test('no role means no share list: the session is this client\'s own', () => {
    expect(roleCanDrive(undefined)).toBe(true)
    expect(roleCanDrive(null)).toBe(true)
  })
})

describe('canDriveSession', () => {
  test('a viewer on a linked host cannot drive the session', () => {
    linkedHosts.add('host-a')
    shareAs('host-a', 'session-1', 'viewer')
    expect(canDriveSession('host-a', 'session-1')).toBe(false)
  })

  test('the role is per session: an editor drives the session shared to them as editor', () => {
    linkedHosts.add('host-a')
    shareAs('host-a', 'session-1', 'viewer')
    shareAs('host-a', 'session-2', 'editor')
    expect(canDriveSession('host-a', 'session-2')).toBe(true)
  })

  test('a host that is not linked shares nothing, so it is never asked and the client drives', async () => {
    shareAs('host-local', 'session-1', 'viewer')
    expect(canDriveSession('host-local', 'session-1')).toBe(true)
    await Promise.resolve()
    expect(loads).toEqual([])
  })

  test('an unknown role asks the host once and drives until it answers', async () => {
    linkedHosts.add('host-b')
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
