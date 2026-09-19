import { describe, expect, test } from 'bun:test'
import { RPC_INVOKE_METHODS } from '@solus/contracts/rpc'
import type { ResourceRole, ShareResource } from '@solus/contracts/sharing'
import {
  GUEST_HOST_RPC_METHODS,
  HOST_ADMIN_RPC_METHODS,
  PER_PERSON_ON_SERVICE_RPC_METHODS,
  RESOURCE_RPC_RULES,
  RpcAccessError,
  assertRpcAccess,
  rpcAccessMap,
} from '@solus/server/server/access-policy'
import type { Principal } from '@solus/server/server/principal'
import { resetWorkspaceModeForTests } from '@solus/server/server/workspace-mode'

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
  return { roleFor: async (_principal: Principal, resource: ShareResource) => roles[`${resource.kind}:${resource.id}`] ?? 'none' }
}

const ctx = (sessionId: string) => ({ session: { sessionId, provider: null, agentSessionId: null }, window: {}, settings: {}, statusBar: {} })

describe('the access map', () => {
  test('classifies every registered method, and every session or work method is resource-classed', async () => {
    const map = rpcAccessMap()
    expect([...map.keys()].sort()).toEqual([...RPC_INVOKE_METHODS].sort())
    // A method that names a session or a work in its name must carry a resource rule
    // unless it is a catalog read (listSessions, listWorks) or a creation.
    // `tasksPrepareForSession` mints a task before any session exists; the others list or create.
    const catalog = new Set(['listSessions', 'searchSessions', 'sessionRecordList', 'sessionRecordUpsert', 'listWorks', 'createWork', 'createHeadlessSession', 'connectionsListSessions', 'pinnedSessionsList', 'tasksPrepareForSession', 'generateSessionMetadata', 'importDocFromUrl', 'docDestinations', 'docProviderStatuses', 'connectionsSetTrustLocalNetwork', 'sessionGuideStatuses'])
    const unclassified = RPC_INVOKE_METHODS.filter((method) => /session|work(?!tree)/i.test(method) && !catalog.has(method) && !RESOURCE_RPC_RULES.has(method))
    expect(unclassified).toEqual([])
  })

  test('a class is a class: no method is in two sets', async () => {
    for (const method of HOST_ADMIN_RPC_METHODS) expect(RESOURCE_RPC_RULES.has(method)).toBe(false)
    for (const method of GUEST_HOST_RPC_METHODS) expect(rpcAccessMap().get(method)).toBe('host-wide')
  })
})

describe('the host itself', () => {
  test('a session record report is the host\'s own to make; no person\'s connection may write one', async () => {
    // WHY: the record is a runner's word about a session (docs/plans/cloud-service-model.md).
    // A client that could write it could list a session that never ran, or hide one that did.
    const report = [{ sessionId: 's1', provider: 'claude-code', projectPath: '-p', lastActivityAt: 1 }]
    await expect(assertRpcAccess('sessionRecordUpsert', { kind: 'system' }, report)).resolves.toBeUndefined()
    await expect(assertRpcAccess('sessionRecordUpsert', OWNER, report)).rejects.toThrow(/only available to the host itself/)
    await expect(assertRpcAccess('sessionRecordUpsert', MEMBER, report)).rejects.toThrow(RpcAccessError)
    await expect(assertRpcAccess('sessionRecordUpsert', GUEST, report)).rejects.toThrow(RpcAccessError)
    expect(rpcAccessMap().get('sessionRecordUpsert')).toBe('system-only')
    // Reading the records is a catalog read: members yes, guests never.
    await expect(assertRpcAccess('sessionRecordList', MEMBER, [{}])).resolves.toBeUndefined()
    await expect(assertRpcAccess('sessionRecordList', GUEST, [{}])).rejects.toThrow(/not available to a guest/)
  })

  test('a runner of the organization makes the system-only writes and nothing else', async () => {
    // WHY (cloud-service-model.md §16): the runner grant is a machine's credential for
    // its organization's workspace; a machine that could list or read would be a
    // member without a person behind it.
    const RUNNER: Principal = { kind: 'runner', hostId: 'h1', organizationId: 'org1', deviceId: 'h1', expiresAt: 0, deviceLabel: 'Runner' }
    const report = [{ sessionId: 's1', provider: 'claude-code', projectPath: '-p', lastActivityAt: 1 }]
    await expect(assertRpcAccess('sessionRecordUpsert', RUNNER, report)).resolves.toBeUndefined()
    for (const method of ['sessionRecordList', 'tasksList', 'listWorks', 'connectionsGetServerInfo', 'configUpdate', 'shareGet'] as const) {
      await expect(assertRpcAccess(method, RUNNER, [{}])).rejects.toThrow(/not available to a runner/)
    }
    await expect(assertRpcAccess('loadWork', RUNNER, ['w1'], resources({ 'work:w1': 'owner' }))).rejects.toThrow(/not available to a runner/)
  })
})

describe('resource calls', () => {
  test('a viewer may read a shared session but not prompt it; an editor may; a stranger sees nothing', async () => {
    const table = resources({ 'session:s1': 'viewer', 'session:s2': 'editor' })
    await expect(assertRpcAccess('watchSession', MEMBER, [{ sessionId: 's1' }], table)).resolves.toBeUndefined()
    await expect(assertRpcAccess('prompt', MEMBER, [ctx('s1'), {}], table)).rejects.toThrow(RpcAccessError)
    await expect(assertRpcAccess('prompt', MEMBER, [ctx('s2'), {}], table)).resolves.toBeUndefined()
    await expect(assertRpcAccess('loadSession', MEMBER, ['s3'], table)).rejects.toThrow(/not shared/)
  })

  test('deleting a work takes the owner; an editor cannot', async () => {
    const table = resources({ 'work:w1': 'editor', 'work:w2': 'owner' })
    await expect(assertRpcAccess('deleteWork', MEMBER, ['w1'], table)).rejects.toThrow(RpcAccessError)
    await expect(assertRpcAccess('deleteWork', MEMBER, ['w2'], table)).resolves.toBeUndefined()
    await expect(assertRpcAccess('shareTransfer', MEMBER, [{ resource: { kind: 'work', id: 'w1' }, toUserId: 'x' }], table)).rejects.toThrow(RpcAccessError)
  })

  test('the host owner passes every resource check without a share table', async () => {
    await expect(assertRpcAccess('deleteWork', OWNER, ['w1'])).resolves.toBeUndefined()
    await expect(assertRpcAccess('prompt', OWNER, [ctx('s1'), {}], resources({}))).resolves.toBeUndefined()
  })

  test('a draft with no session yet is host-wide for a member and refused for a guest', async () => {
    // WHY: attachments for an unsent first prompt name no session; a member may upload, a guest has no draft.
    await expect(assertRpcAccess('attachUpload', MEMBER, [ctx(''), {}], resources({}))).resolves.toBeUndefined()
    await expect(assertRpcAccess('attachUpload', GUEST, [ctx(''), {}], resources({}))).rejects.toThrow(RpcAccessError)
  })
})

describe('guests', () => {
  test('a guest reaches its one resource with its role, a handful of boot calls, and nothing else', async () => {
    const table = resources({ 'session:s1': 'viewer' })
    await expect(assertRpcAccess('watchSession', GUEST, [{ sessionId: 's1' }], table)).resolves.toBeUndefined()
    await expect(assertRpcAccess('prompt', GUEST, [ctx('s1'), {}], table)).rejects.toThrow(RpcAccessError)
    await expect(assertRpcAccess('connectionsGetServerInfo', GUEST, [], table)).resolves.toBeUndefined()
    for (const method of ['listSessions', 'listWorks', 'listProjects', 'start', 'readProjectFile', 'gitRunAction'] as const) {
      await expect(assertRpcAccess(method, GUEST, [], table)).rejects.toThrow(/not available to a guest/)
    }
  })

  test('opening the shared session by id is a resource read; a batch of several ids is a catalog read', async () => {
    // WHY: the client resolves a session's lineage and info before it can render it. A
    // guest must be able to do that for its one session and for nothing else.
    const table = resources({ 'session:s1': 'viewer' })
    await expect(assertRpcAccess('describeSession', GUEST, ['claude-code', 's1'], table)).resolves.toBeUndefined()
    await expect(assertRpcAccess('resolveSessionLineage', GUEST, ['claude-code', 's1'], table)).resolves.toBeUndefined()
    await expect(assertRpcAccess('getSessionInfos', GUEST, [['s1']], table)).resolves.toBeUndefined()
    await expect(assertRpcAccess('describeSession', GUEST, ['claude-code', 's2'], table)).rejects.toThrow(/not shared/)
    await expect(assertRpcAccess('getSessionInfos', GUEST, [['s1', 's2']], table)).rejects.toThrow(RpcAccessError)
    await expect(assertRpcAccess('getSessionInfos', MEMBER, [['s1', 's2']], table)).resolves.toBeUndefined()
  })
})

describe('tasks', () => {
  test('a task is a resource: reading takes a viewer, changing takes an editor, deleting takes the owner; listings stay host-wide and filtered', async () => {
    // WHY: a task shared with someone shares its page; a task page that a viewer
    // could edit, or a member could delete, would undo the share dialog's promise.
    const table = resources({ 'task:t1': 'viewer', 'task:t2': 'editor', 'task:t3': 'owner' })
    await expect(assertRpcAccess('tasksGet', MEMBER, ['t1'], table)).resolves.toBeUndefined()
    await expect(assertRpcAccess('tasksSessions', MEMBER, ['t1'], table)).resolves.toBeUndefined()
    await expect(assertRpcAccess('tasksUpdate', MEMBER, ['t1', {}], table)).rejects.toThrow(RpcAccessError)
    await expect(assertRpcAccess('tasksUpdate', MEMBER, ['t2', {}], table)).resolves.toBeUndefined()
    await expect(assertRpcAccess('tasksComment', MEMBER, ['t2', 'hi'], table)).resolves.toBeUndefined()
    await expect(assertRpcAccess('tasksDelete', MEMBER, ['t2'], table)).rejects.toThrow(RpcAccessError)
    await expect(assertRpcAccess('tasksDelete', MEMBER, ['t3'], table)).resolves.toBeUndefined()
    await expect(assertRpcAccess('tasksGet', MEMBER, ['t9'], table)).rejects.toThrow(/not shared/)
    for (const method of ['tasksList', 'tasksSidebarSnapshot', 'tasksCreate'] as const) expect(rpcAccessMap().get(method)).toBe('host-wide')
  })

  test('a guest on a task reads its page and its filtered listing, and nothing else of the tasks', async () => {
    const taskGuest: Principal = { ...GUEST, share: { ...GUEST.share, resource: { kind: 'task', id: 't1' } } }
    const table = resources({ 'task:t1': 'viewer', 'session:s1': 'viewer' })
    await expect(assertRpcAccess('tasksGet', taskGuest, ['t1'], table)).resolves.toBeUndefined()
    await expect(assertRpcAccess('tasksSidebarSnapshot', taskGuest, [], table)).resolves.toBeUndefined()
    await expect(assertRpcAccess('watchSession', taskGuest, [{ sessionId: 's1' }], table)).resolves.toBeUndefined()
    await expect(assertRpcAccess('tasksGet', taskGuest, ['t2'], table)).rejects.toThrow(/not shared/)
    await expect(assertRpcAccess('tasksCreate', taskGuest, [{}], table)).rejects.toThrow(/not available to a guest/)
    await expect(assertRpcAccess('shareSet', taskGuest, [{ resource: { kind: 'task', id: 't1' }, grants: [] }], table)).rejects.toThrow(RpcAccessError)
  })
})

describe('work comments', () => {
  test('changing a thread takes an editor of the work; a read mark takes only a viewer; a guest has the role of its link', async () => {
    // WHY (multiplayer-comments.md §3): a viewer may follow a conversation and keep
    // their own place in it, but the host must refuse their comment before the
    // composer would have shown it as sent.
    const table = resources({ 'work:w1': 'viewer', 'work:w2': 'editor' })
    const add = { kind: 'add', comment: { id: 'c', selectedText: 'x', comment: 'note' } }
    await expect(assertRpcAccess('applyWorkComment', MEMBER, ['w1', add], table)).rejects.toThrow(RpcAccessError)
    await expect(assertRpcAccess('applyWorkComment', MEMBER, ['w2', add], table)).resolves.toBeUndefined()
    await expect(assertRpcAccess('markWorkCommentRead', MEMBER, ['w1', 'c'], table)).resolves.toBeUndefined()
    // The share table answers a guest only for the one work its link names.
    const workGuest: Principal = { ...GUEST, share: { ...GUEST.share, resource: { kind: 'work', id: 'w1' } } }
    const guestTable = resources({ 'work:w1': 'viewer' })
    await expect(assertRpcAccess('markWorkCommentRead', workGuest, ['w1', 'c'], guestTable)).resolves.toBeUndefined()
    await expect(assertRpcAccess('applyWorkComment', workGuest, ['w1', add], guestTable)).rejects.toThrow(RpcAccessError)
    await expect(assertRpcAccess('applyWorkComment', workGuest, ['w2', add], guestTable)).rejects.toThrow(/not shared/)
    await expect(assertRpcAccess('applyWorkComment', workGuest, ['w1', add], resources({ 'work:w1': 'editor' }))).resolves.toBeUndefined()
  })
})

describe('provider seats', () => {
  test('a member connects and lists only their own seats (host-wide); a guest never; removal is administration', async () => {
    // WHY (Step 2 plan §3.2): the seat handlers read the caller's identity from the
    // principal, so the class only has to keep guests out and reserve removal.
    for (const method of ['seatList', 'seatConnectStart', 'seatConnectSubmitCode', 'seatConnectCancel', 'seatConnectToken', 'seatDisconnect'] as const) {
      expect(rpcAccessMap().get(method)).toBe('host-wide')
      await expect(assertRpcAccess(method, MEMBER, [{ provider: 'claude-code' }])).resolves.toBeUndefined()
      await expect(assertRpcAccess(method, GUEST, [{ provider: 'claude-code' }])).rejects.toThrow(/not available to a guest/)
    }
    expect(rpcAccessMap().get('seatRemove')).toBe('host-admin')
    await expect(assertRpcAccess('seatRemove', MEMBER, [{ userId: 'bob' }])).rejects.toThrow(RpcAccessError)
    await expect(assertRpcAccess('seatRemove', ORG_OWNER_MANAGED, [{ userId: 'bob' }])).resolves.toBeUndefined()
  })
})

describe('presence', () => {
  test('anyone reads the room and reports focus; typing in a session takes the right to prompt it', async () => {
    // WHY (multiplayer-presence.md): a guest needs its own client id to leave itself
    // out of a stack, and its focus is clamped by the handler; but "typing" is shown
    // beside the composer, which only an editor of that session has.
    const table = resources({ 'session:s1': 'viewer', 'session:s2': 'editor' })
    for (const method of ['presenceSnapshot', 'presenceSetFocus'] as const) {
      expect(rpcAccessMap().get(method)).toBe('host-wide')
      await expect(assertRpcAccess(method, GUEST, [{ focus: { kind: 'none' } }], table)).resolves.toBeUndefined()
    }
    expect(rpcAccessMap().get('presenceSetComposing')).toBe('resource')
    await expect(assertRpcAccess('presenceSetComposing', MEMBER, [{ sessionId: 's2', isComposing: true }], table)).resolves.toBeUndefined()
    await expect(assertRpcAccess('presenceSetComposing', MEMBER, [{ sessionId: 's1', isComposing: true }], table)).rejects.toThrow(RpcAccessError)
    await expect(assertRpcAccess('presenceSetComposing', GUEST, [{ sessionId: 's1', isComposing: true }], table)).rejects.toThrow(RpcAccessError)
  })
})

describe('host administration', () => {
  test('is the personal host owner, or an organization owner on a managed host; never a plain member', async () => {
    await expect(assertRpcAccess('configUpdate', OWNER, [{}])).resolves.toBeUndefined()
    await expect(assertRpcAccess('configUpdate', ORG_OWNER_MANAGED, [{}])).resolves.toBeUndefined()
    await expect(assertRpcAccess('configUpdate', ORG_OWNER_PERSONAL, [{}])).rejects.toThrow(RpcAccessError)
    await expect(assertRpcAccess('configUpdate', MEMBER, [{}])).rejects.toThrow(RpcAccessError)
    await expect(assertRpcAccess('configUpdate', GUEST, [{}])).rejects.toThrow(RpcAccessError)
  })

  test('local-only methods refuse even the organization owner of a managed host', async () => {
    await expect(assertRpcAccess('uplinkLink', ORG_OWNER_MANAGED, [{}])).rejects.toThrow(/local connection/)
    await expect(assertRpcAccess('uplinkLink', OWNER, [{}])).resolves.toBeUndefined()
  })

  test("a provider connection is the host's on a host, and each person's own on the workspace service", async () => {
    // WHY (cloud-service-model.md §22): on a host `providerConnect` replaces the
    // machine's one GitHub token, so only its administrator may; on the service
    // the handler writes the caller's own vault row, so every member may.
    expect(rpcAccessMap().get('providerConnect')).toBe('host-admin')
    await expect(assertRpcAccess('providerConnect', OWNER, [ctx('s1')])).resolves.toBeUndefined()
    await expect(assertRpcAccess('providerConnect', MEMBER, [ctx('s1')])).rejects.toThrow(RpcAccessError)
    process.env.SOLUS_WORKSPACE = '1'
    resetWorkspaceModeForTests()
    try {
      for (const method of [...PER_PERSON_ON_SERVICE_RPC_METHODS]) {
        await expect(assertRpcAccess(method, MEMBER, [ctx('s1')], undefined, true)).resolves.toBeUndefined()
        await expect(assertRpcAccess(method, GUEST, [ctx('s1')], undefined, true)).rejects.toThrow(/not available to a guest/)
      }
      // Exporting the host's token stays the host's alone, service or not.
      await expect(assertRpcAccess('githubExportCredential', MEMBER, [], undefined, true)).rejects.toThrow(RpcAccessError)
    } finally {
      delete process.env.SOLUS_WORKSPACE
      resetWorkspaceModeForTests()
    }
    await expect(assertRpcAccess('providerConnect', MEMBER, [ctx('s1')])).rejects.toThrow(RpcAccessError)
  })
})

test('only host administrators can change the TypeSafe key', async () => {
  expect(rpcAccessMap().get('typeSafeKeySet')).toBe('host-admin')
  await expect(assertRpcAccess('typeSafeKeySet', OWNER, ['synthetic-key'])).resolves.toBeUndefined()
  await expect(assertRpcAccess('typeSafeKeySet', MEMBER, ['synthetic-key'])).rejects.toThrow(RpcAccessError)
  await expect(assertRpcAccess('typeSafeKeySet', GUEST, [null])).rejects.toThrow(RpcAccessError)
})
