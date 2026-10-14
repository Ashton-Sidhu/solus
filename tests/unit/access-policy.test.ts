import { describe, expect, test } from 'bun:test'
import { RPC_INVOKE_METHODS } from '@solus/contracts/rpc'
import type { ResourceRole, ShareResource } from '@solus/contracts/sharing'
import { GUEST_HOST_ACTIONS, RESOURCE_LOCATORS, RpcAccessError, assertRpcAccess, grantsFor } from '@solus/server/admission/access-policy'
import { RESOURCE_VERB_OF_METHOD, grantsAllow, hostActionOf, isResourceMethod } from '@solus/contracts/permissions'
import type { Principal } from '@solus/server/admission/principal'
import { resetApiModeForTests } from '@solus/server/host/api-mode'

// docs/plans/permissions.md: every method needs one action, declared once in the
// contracts. A host action is held as a grant on the whole host; a resource verb is
// held through the share role on the session, work, or task the call names. A guest's
// grants are a few reads; host administration is the host owner's (or, on a managed
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

describe('the action tables', () => {
  test('every registered method needs exactly one action, and every session or work method a resource verb', async () => {
    for (const method of RPC_INVOKE_METHODS) {
      // A resource method has a verb and a locator; a host method has an action and neither.
      expect(isResourceMethod(method) ? method in RESOURCE_LOCATORS && hostActionOf(method) === null : typeof hostActionOf(method) === 'string').toBe(true)
    }
    expect(Object.keys(RESOURCE_LOCATORS).sort()).toEqual(Object.keys(RESOURCE_VERB_OF_METHOD).sort())
    // A method that names a session or a work in its name must carry a resource verb
    // unless it is a catalog read (listSessions, listWorks) or a creation.
    // `tasksPrepareForSession` binds a task before any session exists; the others list or create.
    const catalog = new Set(['sessionRecordList', 'sessionRecordUpsert', 'listWorks', 'createWork', 'createHeadlessSession', 'connectionsListSessions', 'pinnedSessionsList', 'tasksPrepareForSession', 'generateSessionMetadata', 'importDocFromUrl', 'docDestinations', 'docProviderStatuses', 'connectionsSetTrustLocalNetwork', 'sessionGuideStatuses', 'workReviewInbox', 'workReviewStates', 'workUpload'])
    const unclassified = RPC_INVOKE_METHODS.filter((method) => /session|work(?!tree|space)/i.test(method) && !catalog.has(method) && !isResourceMethod(method))
    expect(unclassified).toEqual([])
  })

  test('a grant is a prefix: splitting an action under it changes nothing for whoever holds the parent', async () => {
    // WHY (permissions.md): adding or narrowing an action must be one row and one call,
    // never a change to every principal's standing.
    expect(grantsAllow(['host'], 'host.git.write')).toBe(true)
    expect(grantsAllow(['host.git'], 'host.git.push')).toBe(true)
    expect(grantsAllow(['host.git.read'], 'host.git.write')).toBe(false)
    expect(grantsAllow(['host.gitlab'], 'host.git.read')).toBe(false)
    expect(grantsFor(OWNER, false)).toContain('host.local')
    expect(grantsAllow(grantsFor(OWNER, true), 'host.local.reach')).toBe(false)
    expect(grantsAllow(grantsFor(OWNER, true), 'host.local.window')).toBe(true)
    expect(grantsFor(GUEST)).toEqual([...GUEST_HOST_ACTIONS])
    for (const action of GUEST_HOST_ACTIONS) expect(grantsAllow(grantsFor(MEMBER), action)).toBe(true)
  })
})

describe('cloud sharing of a work or a task', () => {
  test('only the owner of a work or a task may read it out of its host or remove it after upload; any member may upload, a guest may not', async () => {
    // WHY: a work leaves its host only by its owner's Share (docs/plans/cloud-sharing.md).
    // An editor who could export it could copy it out; one who could remove it could delete it.
    const editorOnly = resources({ 'work:w1': 'editor' })
    const ownerOnly = resources({ 'work:w1': 'owner' })
    for (const method of ['workExportForCloud', 'workMarkMoved'] as const) {
      await expect(assertRpcAccess(method, MEMBER, ['w1'], editorOnly, false)).rejects.toThrow(RpcAccessError)
      await expect(assertRpcAccess(method, MEMBER, ['w1'], ownerOnly, false)).resolves.toBeUndefined()
    }
    const taskEditor = resources({ 'task:t1': 'editor' })
    const taskOwner = resources({ 'task:t1': 'owner' })
    for (const method of ['taskExportForCloud', 'taskMarkMoved'] as const) {
      await expect(assertRpcAccess(method, MEMBER, ['t1'], taskEditor, false)).rejects.toThrow(RpcAccessError)
      await expect(assertRpcAccess(method, MEMBER, ['t1'], taskOwner, false)).resolves.toBeUndefined()
    }
    // The upload names no stored resource: the Solus API puts it in the caller's own organization.
    for (const method of ['workUpload', 'taskUpload'] as const) {
      await expect(assertRpcAccess(method, MEMBER, [{}], editorOnly, false)).resolves.toBeUndefined()
      await expect(assertRpcAccess(method, GUEST, [{}], editorOnly, false)).rejects.toThrow(RpcAccessError)
    }
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
    expect(hostActionOf('sessionRecordUpsert')).toBe('host.system')
    // Stored record reads now use the authorized HTTP operations.
  })

  test('a runner of the organization makes the system-only writes and nothing else', async () => {
    // WHY (cloud-service-model.md §16): the runner grant is a machine's credential for
    // its organization's workspace; a machine that could list or read would be a
    // member without a person behind it.
    const RUNNER: Principal = { kind: 'runner', hostId: 'h1', organizationId: 'org1', ownerUserId: 'bob', deviceId: 'h1', expiresAt: 0, deviceLabel: 'Runner' }
    const report = [{ sessionId: 's1', provider: 'claude-code', projectPath: '-p', lastActivityAt: 1 }]
    await expect(assertRpcAccess('sessionRecordUpsert', RUNNER, report)).resolves.toBeUndefined()
    for (const method of ['tasksSidebarSnapshot', 'connectionsGetServerInfo', 'configUpdate', 'shareGet'] as const) {
      await expect(assertRpcAccess(method, RUNNER, [{}])).rejects.toThrow(/not available to a runner/)
    }
    await expect(assertRpcAccess('loadWorkRevisions', RUNNER, ['w1'], resources({ 'work:w1': 'owner' }))).rejects.toThrow(/not available to a runner/)
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

  test('transferring a work takes the owner; an editor cannot', async () => {
    const table = resources({ 'work:w1': 'editor', 'work:w2': 'owner' })
    await expect(assertRpcAccess('shareTransfer', MEMBER, [{ resource: { kind: 'work', id: 'w1' }, toUserId: 'x' }], table)).rejects.toThrow(RpcAccessError)
    await expect(assertRpcAccess('shareTransfer', MEMBER, [{ resource: { kind: 'work', id: 'w2' }, toUserId: 'x' }], table)).resolves.toBeUndefined()
  })

  test('the host owner passes every resource check without a share table', async () => {
    await expect(assertRpcAccess('prompt', OWNER, [ctx('s1'), {}], resources({}))).resolves.toBeUndefined()
  })

  test('a draft with no session yet is host-wide for a member and refused for a guest', async () => {
    // WHY: attachments for an unsent first prompt name no session; a member may upload, a guest has no draft.
    await expect(assertRpcAccess('attachUpload', MEMBER, [ctx(''), {}], resources({}))).resolves.toBeUndefined()
    await expect(assertRpcAccess('attachUpload', GUEST, [ctx(''), {}], resources({}))).rejects.toThrow(RpcAccessError)
  })
})

describe('guests', () => {
  test('a guest reaches its one resource with its role, the reads its workspace needs, and nothing else', async () => {
    // WHY (host-sharing.md, permissions.md): a guest gets the real workspace, so it reads the agents,
    // the models, the filtered session lists, and git for the shared checkout; it changes nothing of the host.
    const table = resources({ 'session:s1': 'viewer' })
    await expect(assertRpcAccess('watchSession', GUEST, [{ sessionId: 's1' }], table)).resolves.toBeUndefined()
    await expect(assertRpcAccess('prompt', GUEST, [ctx('s1'), {}], table)).rejects.toThrow(RpcAccessError)
    for (const method of ['connectionsGetServerInfo', 'start', 'modelProfilesStatus', 'pinnedSessionsList', 'gitRefreshState', 'listProjectFiles', 'readProjectFile'] as const) {
      await expect(assertRpcAccess(method, GUEST, [], table)).resolves.toBeUndefined()
    }
    for (const method of ['listWorks', 'listProjects', 'writeFile', 'mutateProjectFile', 'gitRunAction', 'openWorktreeTerminal', 'usageLimits', 'configGet', 'createHeadlessSession'] as const) {
      await expect(assertRpcAccess(method, GUEST, [], table)).rejects.toThrow(/not available to a guest/)
    }
  })

  test('opening the shared session by id is a resource read; a batch of several ids is a catalog read', async () => {
    // WHY: the client resolves a session's lineage and info before it can render it. A
    // guest must be able to do that for its one session and for nothing else.
    const table = resources({ 'session:s1': 'viewer' })
    await expect(assertRpcAccess('describeSession', GUEST, ['s1'], table)).resolves.toBeUndefined()
    await expect(assertRpcAccess('getSessionInfos', GUEST, [['s1']], table)).resolves.toBeUndefined()
    await expect(assertRpcAccess('describeSession', GUEST, ['s2'], table)).rejects.toThrow(/not shared/)
    await expect(assertRpcAccess('getSessionInfos', GUEST, [['s1', 's2']], table)).rejects.toThrow(RpcAccessError)
    await expect(assertRpcAccess('getSessionInfos', MEMBER, [['s1', 's2']], table)).resolves.toBeUndefined()
  })
})

describe('tasks', () => {
  test('a task is a resource: reading takes a viewer, changing takes an editor, deleting takes the owner; listings stay host-wide and filtered', async () => {
    // WHY: a task shared with someone shares its page; a task page that a viewer
    // could edit, or a member could delete, would undo the share dialog's promise.
    const table = resources({ 'task:t1': 'viewer', 'task:t2': 'editor', 'task:t3': 'owner' })
    await expect(assertRpcAccess('tasksReadExtras', MEMBER, ['t1'], table)).resolves.toBeUndefined()
    await expect(assertRpcAccess('tasksSessions', MEMBER, ['t1'], table)).resolves.toBeUndefined()
    await expect(assertRpcAccess('tasksComment', MEMBER, ['t2', 'hi'], table)).resolves.toBeUndefined()
    await expect(assertRpcAccess('tasksReadExtras', MEMBER, ['t9'], table)).rejects.toThrow(/not shared/)
    expect(hostActionOf('tasksSidebarSnapshot')).toBe('host.sessions.read')
  })

  test('a guest reads the task listing only as the filter leaves it: nothing, since a link opens no task', async () => {
    // WHY: a link opens a work or a session; the listing's `filterVisible` keeps only what the guest may open.
    const table = resources({ 'task:t1': 'viewer' })
    await expect(assertRpcAccess('tasksSidebarSnapshot', GUEST, [], table)).resolves.toBeUndefined()
    // The share manager answers a guest only for the resource its link names: a task is never it.
    await expect(assertRpcAccess('tasksReadExtras', GUEST, ['t1'], resources({}))).rejects.toThrow(/not shared/)
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
      expect(hostActionOf(method)).toBe('host.use')
      await expect(assertRpcAccess(method, MEMBER, [{ provider: 'claude-code' }])).resolves.toBeUndefined()
      await expect(assertRpcAccess(method, GUEST, [{ provider: 'claude-code' }])).rejects.toThrow(/not available to a guest/)
    }
    expect(hostActionOf('seatRemove')).toBe('host.admin')
    await expect(assertRpcAccess('seatRemove', MEMBER, [{ userId: 'bob' }])).rejects.toThrow(RpcAccessError)
    await expect(assertRpcAccess('seatRemove', ORG_OWNER_MANAGED, [{ userId: 'bob' }])).resolves.toBeUndefined()
  })
})

describe('integration connections', () => {
  test('a member signs in to an integration as themselves (host-wide); a guest never', async () => {
    // WHY (mcp-integrations.md §4.1): a connection belongs to the caller, and the
    // handler selects it from the principal, so the class only keeps guests out.
    for (const method of ['integrationConnectionList', 'integrationConnectStart', 'integrationConnectSubmit', 'integrationConnectCancel', 'integrationDisconnect'] as const) {
      expect(hostActionOf(method)).toBe('host.use')
      await expect(assertRpcAccess(method, MEMBER, [{ id: 'i1' }])).resolves.toBeUndefined()
      await expect(assertRpcAccess(method, GUEST, [{ id: 'i1' }])).rejects.toThrow(/not available to a guest/)
    }
  })
})

describe('presence', () => {
  test('anyone reads the room and reports focus; typing in a session takes the right to prompt it', async () => {
    // WHY (multiplayer-presence.md): a guest needs its own client id to leave itself
    // out of a stack, and its focus is clamped by the handler; but "typing" is shown
    // beside the composer, which only an editor of that session has.
    const table = resources({ 'session:s1': 'viewer', 'session:s2': 'editor' })
    for (const method of ['presenceSnapshot', 'presenceSetFocus'] as const) {
      expect(hostActionOf(method)).toBe('host.connect')
      await expect(assertRpcAccess(method, GUEST, [{ focus: { kind: 'none' } }], table)).resolves.toBeUndefined()
    }
    expect(isResourceMethod('presenceSetComposing')).toBe(true)
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
    expect(hostActionOf('providerConnect')).toBe('host.admin.connections')
    await expect(assertRpcAccess('providerConnect', OWNER, [ctx('s1')])).resolves.toBeUndefined()
    await expect(assertRpcAccess('providerConnect', MEMBER, [ctx('s1')])).rejects.toThrow(RpcAccessError)
    process.env.SOLUS_API = '1'
    resetApiModeForTests()
    try {
      for (const method of ['googleConnect', 'googleDisconnect', 'atlassianStartOAuth', 'atlassianCancelOAuth', 'atlassianDisconnect', 'providerConnect', 'providerCancelConnect', 'providerDisconnect'] as const) {
        await expect(assertRpcAccess(method, MEMBER, [ctx('s1')], undefined, true)).resolves.toBeUndefined()
        await expect(assertRpcAccess(method, GUEST, [ctx('s1')], undefined, true)).rejects.toThrow(/not available to a guest/)
      }
      // Exporting the host's token stays the host's alone, service or not.
      await expect(assertRpcAccess('githubExportCredential', MEMBER, [], undefined, true)).rejects.toThrow(RpcAccessError)
    } finally {
      delete process.env.SOLUS_API
      resetApiModeForTests()
    }
    await expect(assertRpcAccess('providerConnect', MEMBER, [ctx('s1')])).rejects.toThrow(RpcAccessError)
  })
})

test('only host administrators can change the TypeSafe key', async () => {
  expect(hostActionOf('typeSafeKeySet')).toBe('host.admin')
  await expect(assertRpcAccess('typeSafeKeySet', OWNER, ['synthetic-key'])).resolves.toBeUndefined()
  await expect(assertRpcAccess('typeSafeKeySet', MEMBER, ['synthetic-key'])).rejects.toThrow(RpcAccessError)
  await expect(assertRpcAccess('typeSafeKeySet', GUEST, [null])).rejects.toThrow(RpcAccessError)
})
