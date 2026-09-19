import { describe, expect, test } from 'bun:test'
import { RPC_INVOKE_METHODS } from '@solus/contracts/rpc'
import type { ResourceRole, ShareResource } from '@solus/contracts/sharing'
import {
  GUEST_HOST_RPC_METHODS,
  HOST_ADMIN_RPC_METHODS,
  RESOURCE_RPC_RULES,
  RpcAccessError,
  assertRpcAccess,
  rpcAccessMap,
} from '@solus/server/server/access-policy'
import type { Principal } from '@solus/server/server/principal'

// docs/plans/multiplayer-sharing.md §3.7: every method has exactly one class; a call
// that names a session or work is checked against the caller's role on it; a guest
// is never host-wide; and host administration is the host owner's (or, on a managed
// host, an organization owner's).

const OWNER: Principal = { kind: 'local-owner', deviceId: null, deviceLabel: 'Mac' }
const MEMBER: Principal = { kind: 'org-member', userId: 'bob', organizationId: 'org1', organizationRole: 'member', teamIds: [], hostKind: 'managed', displayName: 'Bob', deviceId: 'd1', expiresAt: 0, deviceLabel: 'Solus cloud' }
const ORG_OWNER_MANAGED: Principal = { ...MEMBER, userId: 'alice', organizationRole: 'owner' }
const ORG_OWNER_PERSONAL: Principal = { ...ORG_OWNER_MANAGED, hostKind: 'personal' }
const GUEST: Principal = { kind: 'guest', guestId: 'g1', displayName: 'Maya', deviceId: 'g1', share: { resource: { kind: 'session', id: 's1' }, role: 'viewer', sharedByUserId: 'alice', linkSecretHash: 'h' }, expiresAt: 0, deviceLabel: 'Guest link' }

/** A share table in one line: `kind:id` → role for the calling principal. */
function resources(roles: Record<string, ResourceRole>) {
  return { roleFor: (_principal: Principal, resource: ShareResource) => roles[`${resource.kind}:${resource.id}`] ?? 'none' }
}

const ctx = (sessionId: string) => ({ session: { sessionId, provider: null, agentSessionId: null }, window: {}, settings: {}, statusBar: {} })

describe('the access map', () => {
  test('classifies every registered method, and every session or work method is resource-classed', () => {
    const map = rpcAccessMap()
    expect([...map.keys()].sort()).toEqual([...RPC_INVOKE_METHODS].sort())
    // A method that names a session or a work in its name must carry a resource rule
    // unless it is a catalog read (listSessions, listWorks) or a creation.
    // `tasksPrepareForSession` mints a task before any session exists; the others list or create.
    const catalog = new Set(['listSessions', 'searchSessions', 'listWorks', 'createWork', 'createHeadlessSession', 'connectionsListSessions', 'pinnedSessionsList', 'tasksPrepareForSession', 'generateSessionMetadata', 'importDocFromUrl', 'docDestinations', 'docProviderStatuses', 'connectionsSetTrustLocalNetwork', 'sessionGuideStatuses'])
    const unclassified = RPC_INVOKE_METHODS.filter((method) => /session|work(?!tree)/i.test(method) && !catalog.has(method) && !RESOURCE_RPC_RULES.has(method))
    expect(unclassified).toEqual([])
  })

  test('a class is a class: no method is in two sets', () => {
    for (const method of HOST_ADMIN_RPC_METHODS) expect(RESOURCE_RPC_RULES.has(method)).toBe(false)
    for (const method of GUEST_HOST_RPC_METHODS) expect(rpcAccessMap().get(method)).toBe('host-wide')
  })
})

describe('resource calls', () => {
  test('a viewer may read a shared session but not prompt it; an editor may; a stranger sees nothing', () => {
    const table = resources({ 'session:s1': 'viewer', 'session:s2': 'editor' })
    expect(() => assertRpcAccess('watchSession', MEMBER, [{ sessionId: 's1' }], table)).not.toThrow()
    expect(() => assertRpcAccess('prompt', MEMBER, [ctx('s1'), {}], table)).toThrow(RpcAccessError)
    expect(() => assertRpcAccess('prompt', MEMBER, [ctx('s2'), {}], table)).not.toThrow()
    expect(() => assertRpcAccess('loadSession', MEMBER, ['s3'], table)).toThrow(/not shared/)
  })

  test('deleting a work takes the owner; an editor cannot', () => {
    const table = resources({ 'work:w1': 'editor', 'work:w2': 'owner' })
    expect(() => assertRpcAccess('deleteWork', MEMBER, ['w1'], table)).toThrow(RpcAccessError)
    expect(() => assertRpcAccess('deleteWork', MEMBER, ['w2'], table)).not.toThrow()
    expect(() => assertRpcAccess('shareTransfer', MEMBER, [{ resource: { kind: 'work', id: 'w1' }, toUserId: 'x' }], table)).toThrow(RpcAccessError)
  })

  test('the host owner passes every resource check without a share table', () => {
    expect(() => assertRpcAccess('deleteWork', OWNER, ['w1'])).not.toThrow()
    expect(() => assertRpcAccess('prompt', OWNER, [ctx('s1'), {}], resources({}))).not.toThrow()
  })

  test('a draft with no session yet is host-wide for a member and refused for a guest', () => {
    // WHY: attachments for an unsent first prompt name no session; a member may upload, a guest has no draft.
    expect(() => assertRpcAccess('attachUpload', MEMBER, [ctx(''), {}], resources({}))).not.toThrow()
    expect(() => assertRpcAccess('attachUpload', GUEST, [ctx(''), {}], resources({}))).toThrow(RpcAccessError)
  })
})

describe('guests', () => {
  test('a guest reaches its one resource with its role, a handful of boot calls, and nothing else', () => {
    const table = resources({ 'session:s1': 'viewer' })
    expect(() => assertRpcAccess('watchSession', GUEST, [{ sessionId: 's1' }], table)).not.toThrow()
    expect(() => assertRpcAccess('prompt', GUEST, [ctx('s1'), {}], table)).toThrow(RpcAccessError)
    expect(() => assertRpcAccess('connectionsGetServerInfo', GUEST, [], table)).not.toThrow()
    for (const method of ['listSessions', 'listWorks', 'listProjects', 'start', 'readProjectFile', 'gitRunAction'] as const) {
      expect(() => assertRpcAccess(method, GUEST, [], table)).toThrow(/not available to a guest/)
    }
  })

  test('opening the shared session by id is a resource read; a batch of several ids is a catalog read', () => {
    // WHY: the client resolves a session's lineage and info before it can render it. A
    // guest must be able to do that for its one session and for nothing else.
    const table = resources({ 'session:s1': 'viewer' })
    expect(() => assertRpcAccess('describeSession', GUEST, ['claude-code', 's1'], table)).not.toThrow()
    expect(() => assertRpcAccess('resolveSessionLineage', GUEST, ['claude-code', 's1'], table)).not.toThrow()
    expect(() => assertRpcAccess('getSessionInfos', GUEST, [['s1']], table)).not.toThrow()
    expect(() => assertRpcAccess('describeSession', GUEST, ['claude-code', 's2'], table)).toThrow(/not shared/)
    expect(() => assertRpcAccess('getSessionInfos', GUEST, [['s1', 's2']], table)).toThrow(RpcAccessError)
    expect(() => assertRpcAccess('getSessionInfos', MEMBER, [['s1', 's2']], table)).not.toThrow()
  })
})

describe('tasks', () => {
  test('a task is a resource: reading takes a viewer, changing takes an editor, deleting takes the owner; listings stay host-wide and filtered', () => {
    // WHY: a task shared with someone shares its page; a task page that a viewer
    // could edit, or a member could delete, would undo the share dialog's promise.
    const table = resources({ 'task:t1': 'viewer', 'task:t2': 'editor', 'task:t3': 'owner' })
    expect(() => assertRpcAccess('tasksGet', MEMBER, ['t1'], table)).not.toThrow()
    expect(() => assertRpcAccess('tasksSessions', MEMBER, ['t1'], table)).not.toThrow()
    expect(() => assertRpcAccess('tasksUpdate', MEMBER, ['t1', {}], table)).toThrow(RpcAccessError)
    expect(() => assertRpcAccess('tasksUpdate', MEMBER, ['t2', {}], table)).not.toThrow()
    expect(() => assertRpcAccess('tasksComment', MEMBER, ['t2', 'hi'], table)).not.toThrow()
    expect(() => assertRpcAccess('tasksDelete', MEMBER, ['t2'], table)).toThrow(RpcAccessError)
    expect(() => assertRpcAccess('tasksDelete', MEMBER, ['t3'], table)).not.toThrow()
    expect(() => assertRpcAccess('tasksGet', MEMBER, ['t9'], table)).toThrow(/not shared/)
    for (const method of ['tasksList', 'tasksSidebarSnapshot', 'tasksCreate'] as const) expect(rpcAccessMap().get(method)).toBe('host-wide')
  })

  test('a guest on a task reads its page and its filtered listing, and nothing else of the tasks', () => {
    const taskGuest: Principal = { ...GUEST, share: { ...GUEST.share, resource: { kind: 'task', id: 't1' } } }
    const table = resources({ 'task:t1': 'viewer', 'session:s1': 'viewer' })
    expect(() => assertRpcAccess('tasksGet', taskGuest, ['t1'], table)).not.toThrow()
    expect(() => assertRpcAccess('tasksSidebarSnapshot', taskGuest, [], table)).not.toThrow()
    expect(() => assertRpcAccess('watchSession', taskGuest, [{ sessionId: 's1' }], table)).not.toThrow()
    expect(() => assertRpcAccess('tasksGet', taskGuest, ['t2'], table)).toThrow(/not shared/)
    expect(() => assertRpcAccess('tasksCreate', taskGuest, [{}], table)).toThrow(/not available to a guest/)
    expect(() => assertRpcAccess('shareSet', taskGuest, [{ resource: { kind: 'task', id: 't1' }, grants: [] }], table)).toThrow(RpcAccessError)
  })
})

describe('work comments', () => {
  test('changing a thread takes an editor of the work; a read mark takes only a viewer; a guest has the role of its link', () => {
    // WHY (multiplayer-comments.md §3): a viewer may follow a conversation and keep
    // their own place in it, but the host must refuse their comment before the
    // composer would have shown it as sent.
    const table = resources({ 'work:w1': 'viewer', 'work:w2': 'editor' })
    const add = { kind: 'add', comment: { id: 'c', selectedText: 'x', comment: 'note' } }
    expect(() => assertRpcAccess('applyWorkComment', MEMBER, ['w1', add], table)).toThrow(RpcAccessError)
    expect(() => assertRpcAccess('applyWorkComment', MEMBER, ['w2', add], table)).not.toThrow()
    expect(() => assertRpcAccess('markWorkCommentRead', MEMBER, ['w1', 'c'], table)).not.toThrow()
    // The share table answers a guest only for the one work its link names.
    const workGuest: Principal = { ...GUEST, share: { ...GUEST.share, resource: { kind: 'work', id: 'w1' } } }
    const guestTable = resources({ 'work:w1': 'viewer' })
    expect(() => assertRpcAccess('markWorkCommentRead', workGuest, ['w1', 'c'], guestTable)).not.toThrow()
    expect(() => assertRpcAccess('applyWorkComment', workGuest, ['w1', add], guestTable)).toThrow(RpcAccessError)
    expect(() => assertRpcAccess('applyWorkComment', workGuest, ['w2', add], guestTable)).toThrow(/not shared/)
    expect(() => assertRpcAccess('applyWorkComment', workGuest, ['w1', add], resources({ 'work:w1': 'editor' }))).not.toThrow()
  })
})

describe('provider seats', () => {
  test('a member connects and lists only their own seats (host-wide); a guest never; removal is administration', () => {
    // WHY (Step 2 plan §3.2): the seat handlers read the caller's identity from the
    // principal, so the class only has to keep guests out and reserve removal.
    for (const method of ['seatList', 'seatConnectStart', 'seatConnectSubmitCode', 'seatConnectCancel', 'seatConnectToken', 'seatDisconnect'] as const) {
      expect(rpcAccessMap().get(method)).toBe('host-wide')
      expect(() => assertRpcAccess(method, MEMBER, [{ provider: 'claude-code' }])).not.toThrow()
      expect(() => assertRpcAccess(method, GUEST, [{ provider: 'claude-code' }])).toThrow(/not available to a guest/)
    }
    expect(rpcAccessMap().get('seatRemove')).toBe('host-admin')
    expect(() => assertRpcAccess('seatRemove', MEMBER, [{ userId: 'bob' }])).toThrow(RpcAccessError)
    expect(() => assertRpcAccess('seatRemove', ORG_OWNER_MANAGED, [{ userId: 'bob' }])).not.toThrow()
  })
})

describe('presence', () => {
  test('anyone reads the room and reports focus; typing in a session takes the right to prompt it', () => {
    // WHY (multiplayer-presence.md): a guest needs its own client id to leave itself
    // out of a stack, and its focus is clamped by the handler; but "typing" is shown
    // beside the composer, which only an editor of that session has.
    const table = resources({ 'session:s1': 'viewer', 'session:s2': 'editor' })
    for (const method of ['presenceSnapshot', 'presenceSetFocus'] as const) {
      expect(rpcAccessMap().get(method)).toBe('host-wide')
      expect(() => assertRpcAccess(method, GUEST, [{ focus: { kind: 'none' } }], table)).not.toThrow()
    }
    expect(rpcAccessMap().get('presenceSetComposing')).toBe('resource')
    expect(() => assertRpcAccess('presenceSetComposing', MEMBER, [{ sessionId: 's2', isComposing: true }], table)).not.toThrow()
    expect(() => assertRpcAccess('presenceSetComposing', MEMBER, [{ sessionId: 's1', isComposing: true }], table)).toThrow(RpcAccessError)
    expect(() => assertRpcAccess('presenceSetComposing', GUEST, [{ sessionId: 's1', isComposing: true }], table)).toThrow(RpcAccessError)
  })
})

describe('host administration', () => {
  test('is the personal host owner, or an organization owner on a managed host; never a plain member', () => {
    expect(() => assertRpcAccess('configUpdate', OWNER, [{}])).not.toThrow()
    expect(() => assertRpcAccess('configUpdate', ORG_OWNER_MANAGED, [{}])).not.toThrow()
    expect(() => assertRpcAccess('configUpdate', ORG_OWNER_PERSONAL, [{}])).toThrow(RpcAccessError)
    expect(() => assertRpcAccess('configUpdate', MEMBER, [{}])).toThrow(RpcAccessError)
    expect(() => assertRpcAccess('configUpdate', GUEST, [{}])).toThrow(RpcAccessError)
  })

  test('local-only methods refuse even the organization owner of a managed host', () => {
    expect(() => assertRpcAccess('uplinkLink', ORG_OWNER_MANAGED, [{}])).toThrow(/local connection/)
    expect(() => assertRpcAccess('uplinkLink', OWNER, [{}])).not.toThrow()
  })
})

test('only host administrators can change the TypeSafe key', () => {
  expect(rpcAccessMap().get('typeSafeKeySet')).toBe('host-admin')
  expect(() => assertRpcAccess('typeSafeKeySet', OWNER, ['synthetic-key'])).not.toThrow()
  expect(() => assertRpcAccess('typeSafeKeySet', MEMBER, ['synthetic-key'])).toThrow(RpcAccessError)
  expect(() => assertRpcAccess('typeSafeKeySet', GUEST, [null])).toThrow(RpcAccessError)
})
