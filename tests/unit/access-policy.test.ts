import { describe, expect, test } from 'bun:test'
import { RPC_INVOKE_METHODS } from '@solus/contracts/rpc'
import type { ResourceRole, ShareResource } from '@solus/contracts/sharing'
import { GUEST_PERMISSIONS, RESOURCE_LOCATORS, RpcAccessError, assertRpcAccess, authorize, permissionsFor } from '@solus/server/admission/access-policy'
import { RESOURCE_VERB_OF_METHOD, permissionsAllow, permissionOf, isResourceMethod } from '@solus/contracts/permissions'
import type { Principal } from '@solus/server/admission/principal'
import { resetApiModeForTests } from '@solus/server/host/api-mode'

// docs/plans/permissions.md: every method needs one action, declared once in the
// contracts. A permission is held on the whole host; a resource verb is held
// through the resource role on the resource the call names. A guest's permissions
// are a few reads; host administration is the host owner's (or, on a managed
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
      expect(isResourceMethod(method) ? method in RESOURCE_LOCATORS && permissionOf(method) === null : typeof permissionOf(method) === 'string').toBe(true)
    }
    expect(Object.keys(RESOURCE_LOCATORS).sort()).toEqual(Object.keys(RESOURCE_VERB_OF_METHOD).sort())
    // A method that names a session or a work in its name must carry a resource verb
    // unless it is a catalog read (listSessions, listWorks) or a creation. A workflow run is not a work.
    // `tasksPrepareForSession` binds a task before any session exists; the others list or create.
    const catalog = new Set(['sessionRecordList', 'sessionRecordUpsert', 'listWorks', 'createWork', 'createHeadlessSession', 'connectionsListSessions', 'pinnedSessionsList', 'tasksPrepareForSession', 'generateSessionMetadata', 'importDocFromUrl', 'docDestinations', 'docProviderStatuses', 'connectionsSetTrustLocalNetwork', 'sessionGuideStatuses', 'workReviewInbox', 'workReviewStates', 'workUpload'])
    const unclassified = RPC_INVOKE_METHODS.filter((method) => /session|work(?!tree|space|flow)/i.test(method) && !catalog.has(method) && !isResourceMethod(method))
    expect(unclassified).toEqual([])
  })

  test('a held permission is a prefix: splitting one under it changes nothing for whoever holds the parent', async () => {
    // WHY (permissions.md): adding or narrowing a permission must be one row and one call,
    // never a change to every principal's standing.
    expect(permissionsAllow(['host'], 'host.git.write')).toBe(true)
    expect(permissionsAllow(['host.git'], 'host.git.push')).toBe(true)
    expect(permissionsAllow(['host.git.read'], 'host.git.write')).toBe(false)
    expect(permissionsAllow(['host.gitlab'], 'host.git.read')).toBe(false)
    expect(permissionsFor(OWNER, false)).toContain('host.local')
    expect(permissionsAllow(permissionsFor(OWNER, true), 'host.local.reach')).toBe(false)
    expect(permissionsAllow(permissionsFor(OWNER, true), 'host.local.window')).toBe(true)
    expect(permissionsFor(GUEST)).toEqual([...GUEST_PERMISSIONS])
    for (const permission of GUEST_PERMISSIONS) expect(permissionsAllow(permissionsFor(MEMBER), permission)).toBe(true)
  })
})

describe('authorize, the one decision', () => {
  test('the RPC gate refuses exactly what authorize refuses, for a permission and for a resource verb', async () => {
    // WHY (access-model.md §2.4): the RPC gate and the Solus API both call
    // authorize, so the order of the checks is written once and the two doors
    // cannot disagree about the same person and resource.
    const table = resources({ 'work:w1': 'viewer' })
    const cases: Array<[Parameters<typeof assertRpcAccess>[0], Principal, unknown[], Parameters<typeof authorize>[1], ShareResource | null]> = [
      ['loadWorkRevisions', MEMBER, ['w1'], 'read', { kind: 'work', id: 'w1' }],
      ['agentSaveWork', MEMBER, ['w1'], 'edit', { kind: 'work', id: 'w1' }],
      ['shareSet', MEMBER, [{ resource: { kind: 'work', id: 'w1' } }], 'share', { kind: 'work', id: 'w1' }],
      ['configUpdate', MEMBER, [{}], 'host.admin', null],
      ['configUpdate', OWNER, [{}], 'host.admin', null],
      ['gitRunAction', GUEST, [ctx('s1')], 'host.git.write', null],
      ['attachFiles', GUEST, [null], 'drive', null],
    ]
    for (const [method, principal, args, action, resource] of cases) {
      const refusal = await authorize(principal, action, resource, { name: method, resources: table, managed: false })
      const gate = await assertRpcAccess(method, principal, args, table, false).then(() => null, (error: unknown) => error)
      expect(gate === null).toBe(refusal === null)
      if (refusal && gate instanceof RpcAccessError) expect(gate.message).toBe(refusal.detail)
    }
  })

  test('a managed host refuses how it is reached, whoever asks', async () => {
    expect(await authorize(OWNER, 'host.local.reach', null, { name: 'uplinkLink', managed: true })).toMatchObject({ code: 'MANAGED_HOST' })
    expect(await authorize(OWNER, 'host.local.reach', null, { name: 'uplinkLink', managed: false })).toBeNull()
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
    expect(permissionOf('sessionRecordUpsert')).toBe('host.system')
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

  test('saved app and child reads use the parent role; live integration access needs drive', async () => {
    const table = resources({ 'session:s1': 'viewer', 'session:s2': 'editor' })
    for (const method of ['loadSessionSubagent', 'mcpAppRead'] as const) {
      await expect(assertRpcAccess(method, MEMBER, [{ sessionId: 's1' }], table)).resolves.toBeUndefined()
      await expect(assertRpcAccess(method, MEMBER, [{ sessionId: 'other' }], table)).rejects.toThrow(RpcAccessError)
    }
    for (const method of ['mcpAppToolInfo', 'mcpAppReadResource', 'mcpAppCallTool'] as const) {
      await expect(assertRpcAccess(method, MEMBER, [{ sessionId: 's1' }], table)).rejects.toThrow(RpcAccessError)
      await expect(assertRpcAccess(method, MEMBER, [{ sessionId: 's2' }], table)).resolves.toBeUndefined()
    }
  })

  test('transferring a work takes the owner; an editor cannot', async () => {
    const table = resources({ 'work:w1': 'editor', 'work:w2': 'owner' })
    await expect(assertRpcAccess('shareTransfer', MEMBER, [{ resource: { kind: 'work', id: 'w1' }, toUserId: 'x' }], table)).rejects.toThrow(RpcAccessError)
    await expect(assertRpcAccess('shareTransfer', MEMBER, [{ resource: { kind: 'work', id: 'w2' }, toUserId: 'x' }], table)).resolves.toBeUndefined()
  })

  test('the host owner holds the role `roleOf` gives them, and passes only before the share manager exists', async () => {
    // WHY (docs/plans/access-model.md §2.5): the host owner is an administrator, an
    // editor of what is not theirs. The gate asks for their role like anyone's; it no
    // longer lets them through every resource check. This changes the earlier rule.
    await expect(assertRpcAccess('prompt', OWNER, [ctx('s1'), {}], resources({ 'session:s1': 'editor' }))).resolves.toBeUndefined()
    await expect(assertRpcAccess('shareTransfer', OWNER, [{ resource: { kind: 'work', id: 'w1' }, toUserId: 'x' }], resources({ 'work:w1': 'editor' }))).resolves.toBeUndefined()
    await expect(assertRpcAccess('workExportForCloud', OWNER, ['w1'], resources({ 'work:w1': 'editor' }), false)).rejects.toThrow(RpcAccessError)
    await expect(assertRpcAccess('prompt', OWNER, [ctx('s1'), {}], resources({}))).rejects.toThrow(/not shared/)
    // The desktop's in-process path, before the share manager exists, serves only its local owner.
    await expect(assertRpcAccess('prompt', OWNER, [ctx('s1'), {}])).resolves.toBeUndefined()
    await expect(assertRpcAccess('prompt', MEMBER, [ctx('s1'), {}])).rejects.toThrow(RpcAccessError)
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
    expect(permissionOf('tasksSidebarSnapshot')).toBe('host.sessions.read')
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
      expect(permissionOf(method)).toBe('host.use')
      await expect(assertRpcAccess(method, MEMBER, [{ provider: 'claude-code' }])).resolves.toBeUndefined()
      await expect(assertRpcAccess(method, GUEST, [{ provider: 'claude-code' }])).rejects.toThrow(/not available to a guest/)
    }
    expect(permissionOf('seatRemove')).toBe('host.admin')
    await expect(assertRpcAccess('seatRemove', MEMBER, [{ userId: 'bob' }])).rejects.toThrow(RpcAccessError)
    await expect(assertRpcAccess('seatRemove', ORG_OWNER_MANAGED, [{ userId: 'bob' }])).resolves.toBeUndefined()
  })
})

describe('integration connections', () => {
  test('a member signs in to an integration as themselves (host-wide); a guest never', async () => {
    // WHY (mcp-integrations.md §4.1): a connection belongs to the caller, and the
    // handler selects it from the principal, so the class only keeps guests out.
    for (const method of ['integrationConnectionList', 'integrationConnectStart', 'integrationConnectSubmit', 'integrationConnectCancel', 'integrationDisconnect'] as const) {
      expect(permissionOf(method)).toBe('host.use')
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
      expect(permissionOf(method)).toBe('host.connect')
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
    expect(permissionOf('providerConnect')).toBe('host.admin.connections')
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

test('a TypeSafe key is changed on a host like the machine\'s other connections; each person reads their own status', async () => {
  // access-model.md §2.6: the host keeps a key only for its own user; a member's is in their account.
  expect(permissionOf('typeSafeKeySet')).toBe('host.admin.connections')
  await expect(assertRpcAccess('typeSafeKeySet', OWNER, ['synthetic-key'])).resolves.toBeUndefined()
  await expect(assertRpcAccess('typeSafeKeySet', MEMBER, ['synthetic-key'])).rejects.toThrow(RpcAccessError)
  await expect(assertRpcAccess('typeSafeKeySet', GUEST, [null])).rejects.toThrow(RpcAccessError)
  await expect(assertRpcAccess('typeSafeKeyStatus', MEMBER, [])).resolves.toBeUndefined()
})

describe('resources with an owner and no ACL entries (docs/plans/access-model.md §2.3, D2, D4)', () => {
  test('an automation: its owner reads, changes, runs, and deletes it; an administrator as an editor too; anyone else nothing', async () => {
    // WHY (D4): a member sees and changes their own automation; a host administrator sees and changes all.
    const owner = resources({ 'automation:a1': 'owner' })
    const admin = resources({ 'automation:a1': 'editor' })
    const stranger = resources({})
    const calls: Array<[Parameters<typeof assertRpcAccess>[0], unknown[]]> = [
      ['automationRead', ['a1']], ['automationListRuns', ['a1']], ['automationReadRun', ['a1', 'r1']], ['automationUpdate', ['a1', {}]],
      ['automationSetEnabled', ['a1', false]], ['automationDelete', ['a1']], ['automationRun', ['a1']], ['automationCancel', ['a1']],
    ]
    for (const [method, args] of calls) {
      await expect(assertRpcAccess(method, MEMBER, args, owner)).resolves.toBeUndefined()
      await expect(assertRpcAccess(method, ORG_OWNER_MANAGED, args, admin)).resolves.toBeUndefined()
      await expect(assertRpcAccess(method, MEMBER, args, stranger)).rejects.toThrow(/not shared/)
      await expect(assertRpcAccess(method, GUEST, args, stranger)).rejects.toThrow(RpcAccessError)
    }
    // Listing and creating are host-wide; the list holds only what the caller may see.
    expect(permissionOf('automationList')).toBe('host.use')
    expect(permissionOf('automationCreate')).toBe('host.use')
  })

  test('a project: every member lists the directory; changing or removing one takes its owner or an administrator', async () => {
    expect(permissionOf('workspaceProjectList')).toBe('host.use')
    for (const [method, args] of [['workspaceProjectUpdate', ['p1', { displayName: 'x' }]], ['workspaceProjectRemove', ['p1']]] as const) {
      await expect(assertRpcAccess(method, MEMBER, [...args], resources({ 'project:p1': 'owner' }))).resolves.toBeUndefined()
      await expect(assertRpcAccess(method, ORG_OWNER_MANAGED, [...args], resources({ 'project:p1': 'editor' }))).resolves.toBeUndefined()
      await expect(assertRpcAccess(method, MEMBER, [...args], resources({}))).rejects.toThrow(RpcAccessError)
    }
  })

  test('a notification: only its recipient marks it', async () => {
    await expect(assertRpcAccess('notificationsSetRead', MEMBER, [{ id: 'n1', read: true }], resources({ 'notification:n1': 'owner' }))).resolves.toBeUndefined()
    await expect(assertRpcAccess('notificationsSetArchived', ORG_OWNER_MANAGED, [{ id: 'n1', archived: true }], resources({}))).rejects.toThrow(RpcAccessError)
  })

  test('arbitrary Insights SQL is an administrator\'s; the filtered reads are everyone\'s', async () => {
    // WHY (D2): SQL cannot be held to the caller's own turns, so it would read every person's.
    await expect(assertRpcAccess('metricsRunSql', OWNER, ['SELECT 1'])).resolves.toBeUndefined()
    await expect(assertRpcAccess('metricsRunSql', ORG_OWNER_MANAGED, ['SELECT 1'])).resolves.toBeUndefined()
    await expect(assertRpcAccess('metricsRunSql', MEMBER, ['SELECT 1'])).rejects.toThrow(/host administrator/)
    for (const method of ['metricsQuery', 'metricsTurnPage', 'metricsTurnListingSummary', 'metricsTurnTrace', 'metricsDistinctValues'] as const) {
      expect(permissionOf(method)).toBe('host.use')
    }
  })

  test('a pull request change is a repository write: a member may, a guest may not', async () => {
    // WHY: one no session links is the repository's; the handler asks for session.edit on one that is.
    for (const method of ['prUpdate', 'prMerge', 'prAddIssueComment', 'prSubmitReview', 'prApproveWorkflowRuns'] as const) {
      expect(permissionOf(method)).toBe('host.git.write')
      await expect(assertRpcAccess(method, MEMBER, [ctx(''), 1])).resolves.toBeUndefined()
      await expect(assertRpcAccess(method, GUEST, [ctx('s1'), 1])).rejects.toThrow(RpcAccessError)
    }
    expect(permissionOf('prGetDetail')).toBe('host.use')
  })
})
