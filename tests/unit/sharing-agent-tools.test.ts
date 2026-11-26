import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'
import { installTestIdentities } from './helpers/acting-identities'
import { DEFAULT_LINK_LIFETIME_MS, cloudShareUrl, type ShareResource } from '@solus/contracts/sharing'
import type { Principal } from '@solus/server/admission/principal'
import type { AgentTool, AgentToolContext, AgentToolResult } from '@solus/server/execution/agents/tools/agent-tool'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// WHY: plans/035-cloud-machine-tools.md §11. An agent shares a session or a work with
// the RPCs of the Share dialog, as the person of the turn, so a guest or a viewer is
// refused where their client is. `shareSet` replaces the whole list, so `share` must
// write back every entry it was not asked to change, custom ones with their actions,
// and must not touch the link. The link is the Share dialog's own URL. The secret
// goes into a conversation only when the agent asks for the link.

const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'solus-sharing-tools-')))
const previousDataDir = process.env.SOLUS_DATA_DIR
process.env.SOLUS_DATA_DIR = dataDir

const SESSION: ShareResource = { kind: 'session', id: 'session-shared' }
const ORIGIN = 'https://acme.solus.example'
const OWNER: Principal = { kind: 'owner', via: 'local', expiresAt: null, deviceId: null, deviceLabel: 'Mac' }
const GUEST_VIEWER: Principal = {
  kind: 'guest', guestId: 'guest-1', displayName: 'Guest', deviceId: 'guest-1', deviceLabel: 'Test', expiresAt: Date.now() + 60_000,
  share: { resource: SESSION, role: 'viewer', sharedByUserId: 'local', linkSecretHash: 'test' },
}

let tools: typeof import('@solus/server/execution/agents/tools/sharing-tools')
let executeAgentTool: typeof import('@solus/server/execution/agents/tools/agent-tool')['executeAgentTool']
let withWorkspaceToolAuthority: typeof import('@solus/server/admission/workspace-tool-authority')['withWorkspaceToolAuthority']
let setProjectToolHost: typeof import('@solus/server/execution/agents/tools/project-tools')['setProjectToolHost']
let server: import('@solus/server/transport/server').SolusServer
let closeDb: () => void
/** What `shareLinkOrigin` answers; a test sets it. */
let origin: string | null = ORIGIN

beforeAll(async () => {
  ;(await import('@solus/server/execution/seats/acting-identity')).actAsHostForTests()
  installTestIdentities()
  tools = await import('@solus/server/execution/agents/tools/sharing-tools')
  ;({ executeAgentTool } = await import('@solus/server/execution/agents/tools/agent-tool'))
  ;({ withWorkspaceToolAuthority } = await import('@solus/server/admission/workspace-tool-authority'))
  ;({ setProjectToolHost } = await import('@solus/server/execution/agents/tools/project-tools'))
  ;({ closeDb } = await import('@solus/server/db'))
  // The handlers a person's client reaches, behind the same access gate.
  const { SolusServer } = await import('@solus/server/transport/server')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  const { registerSharingHandlers } = await import('@solus/server/transport/handlers/sharing-handlers')
  const { getDatabase } = await import('@solus/server/db/database')
  server = new SolusServer()
  // A session this machine knows and nobody has a record for is the machine's own.
  const shares = new ShareManager({ db: getDatabase(), sessionExists: () => true })
  server.useResourceAccess(shares)
  registerSharingHandlers(server, { shares })
  server.register('shareLinkOrigin', async () => ({ origin }))
  // SAFETY: the sharing tools send only these four methods.
  setProjectToolHost({ rpc: {
    shareGet: (args, caller) => server.handle('shareGet', args, caller),
    shareSet: (args, caller) => server.handle('shareSet', args, caller),
    shareSetLink: (args, caller) => server.handle('shareSetLink', args, caller),
    shareLinkOrigin: (args, caller) => server.handle('shareLinkOrigin', args, caller),
  } } as never)
})

afterEach(async () => {
  origin = ORIGIN
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  setProjectToolHost(null)
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

/** A turn of the session that is shared: a tool without `resource` acts on it. */
const context: AgentToolContext = {
  provider: 'codex', cwd: dataDir, sessionId: () => SESSION.id, abortSignal: new AbortController().signal,
  parentToolUseId: () => undefined, emit: () => {},
}

/** One call as the agent makes it: parsed against the tool's fields, as the person of the turn. */
function call(tool: AgentTool, input: object, principal: Principal = OWNER): Promise<AgentToolResult> {
  return withWorkspaceToolAuthority(principal, () => executeAgentTool(tool, input, context))
}

const asClient = (principal: Principal) => ({ principal, clientId: 'client', abortSignal: new AbortController().signal })
const readAsOwner = () => server.handle('shareGet', [{ resource: SESSION }], asClient(OWNER))

describe('share', () => {
  test('changes only the entries it names, and keeps custom entries and the link', async () => {
    await server.handle('shareSet', [{ resource: SESSION, entries: [
      { subject: { kind: 'user', id: 'user_ann' }, role: 'viewer' },
      { subject: { kind: 'user', id: 'user_bob' }, role: 'custom', actions: ['read.transcript', 'drive.prompt'] },
      { subject: { kind: 'team', id: 'team_ops' }, role: 'viewer' },
    ] }], asClient(OWNER))
    const link = await server.handle('shareSetLink', [{ resource: SESSION, role: 'viewer', expiresInMs: null }], asClient(OWNER))

    const result = await call(tools.shareAgentTool, {
      add: [{ subject: { kind: 'team', id: 'team_ops' }, role: 'editor' }, { subject: { kind: 'user', id: 'user_cat' }, role: 'commenter' }],
      remove: [{ kind: 'user', id: 'user_ann' }],
    })
    expect(result).toMatchObject({ ok: true })
    expect(JSON.parse(result.text).note).toBe('On a session, commenter acts as viewer.')

    const after = await readAsOwner()
    expect(after.entries.map(({ subject, role, actions }) => ({ subject, role, actions })).sort((a, b) => a.subject.id.localeCompare(b.subject.id))).toEqual([
      { subject: { kind: 'team', id: 'team_ops' }, role: 'editor', actions: undefined },
      { subject: { kind: 'user', id: 'user_bob' }, role: 'custom', actions: ['read.transcript', 'drive.prompt'] },
      { subject: { kind: 'user', id: 'user_cat' }, role: 'commenter', actions: undefined },
    ])
    expect(after.link).toMatchObject({ role: 'viewer', expiresAt: null, secret: link!.secret })
  })

  test('refuses the custom role and changes nothing', async () => {
    const result = await call(tools.shareAgentTool, { add: [{ subject: { kind: 'user', id: 'user_ann' }, role: 'custom' }] })
    expect(result.ok).toBe(false)
    expect((await readAsOwner()).entries).toEqual([])
  })
})

describe('share links', () => {
  test('create_share_link returns the URL of the Share dialog, viewer for 24 hours by default', async () => {
    const before = Date.now()
    const result = await call(tools.createShareLinkAgentTool, {})
    expect(result.ok).toBe(true)
    const answer = JSON.parse(result.text)
    const { link } = await readAsOwner()
    expect(link).toMatchObject({ role: 'viewer' })
    expect(link!.expiresAt! - before).toBeGreaterThanOrEqual(DEFAULT_LINK_LIFETIME_MS - 1_000)
    expect(link!.expiresAt! - before).toBeLessThanOrEqual(DEFAULT_LINK_LIFETIME_MS + 5_000)
    expect(answer).toMatchObject({ resource: SESSION, role: 'viewer', ends: new Date(link!.expiresAt!).toISOString() })
    expect(answer.url).toBe(cloudShareUrl(ORIGIN, SESSION, link!.secret!))
    expect(answer.note).toContain('Anyone who can read this conversation')
  })

  test('with no origin, the link is on but no URL is given', async () => {
    origin = null
    const result = await call(tools.createShareLinkAgentTool, { role: 'editor', expires_in: '7d' })
    const answer = JSON.parse(result.text)
    const { link } = await readAsOwner()
    expect(link).toMatchObject({ role: 'editor' })
    expect(answer.url).toBeNull()
    expect(answer.note).toContain('nobody off this machine can open it')
    expect(result.text).not.toContain(link!.secret!)
  })

  test('read_sharing never gives the secret, even to the owner who may copy it', async () => {
    await call(tools.createShareLinkAgentTool, {})
    const { link } = await readAsOwner()
    expect(link!.secret).toBeTruthy()
    const result = await call(tools.readSharingAgentTool, {})
    expect(result.ok).toBe(true)
    expect(JSON.parse(result.text).link).toEqual({ on: true, role: 'viewer', ends: new Date(link!.expiresAt!).toISOString() })
    expect(result.text).not.toContain(link!.secret!)
  })

  test('remove_share_link turns the link off', async () => {
    await call(tools.createShareLinkAgentTool, {})
    expect((await call(tools.removeShareLinkAgentTool, {})).ok).toBe(true)
    expect((await readAsOwner()).link).toBeNull()
  })
})

describe('the gate of a client', () => {
  test('a guest viewer is refused as its client is, and nothing changes', async () => {
    const refusal = async (method: 'shareSet' | 'shareSetLink', args: never) => {
      try { await server.handle(method, args, asClient(GUEST_VIEWER)); return null } catch (error) { return (error as Error).message }
    }
    const clientShare = await refusal('shareSet', [{ resource: SESSION, entries: [{ subject: { kind: 'user', id: 'user_ann' }, role: 'viewer' }] }] as never)
    const clientLink = await refusal('shareSetLink', [{ resource: SESSION, role: 'viewer' }] as never)
    expect(clientShare).not.toBeNull()
    expect(clientLink).not.toBeNull()

    const shared = await call(tools.shareAgentTool, { add: [{ subject: { kind: 'user', id: 'user_ann' }, role: 'viewer' }] }, GUEST_VIEWER)
    const linked = await call(tools.createShareLinkAgentTool, {}, GUEST_VIEWER)
    expect(shared.ok).toBe(false)
    expect(linked).toEqual({ ok: false, text: clientLink! })
    const after = await readAsOwner()
    expect(after.entries).toEqual([])
    expect(after.link).toBeNull()
  })
})
