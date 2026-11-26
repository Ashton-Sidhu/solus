import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import type { RemoteTarget } from '@solus/server/execution/orchestration/session-orchestrator'
import type { Principal } from '@solus/server/admission/principal'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// WHY: `start_sessions` with `host` starts the work on another host the turn's person
// reaches, as if they started it there (docs/plans/cross-host-sessions.md,
// docs/plans/host-reach.md). The tool must refuse what it cannot honour — no way to
// reach other hosts here, a task across hosts, a turn whose person reaches no other
// host — before it reaches the other host; it must look the host up for that person; check the model against what that host offers, not
// this one; list that host's projects so an agent can pick a cwd there; never
// resolve the other host's path here; and tell the other host
// which session started it. A message to a session it started there goes to
// that host, with its attachments. A read of a session this host does not hold
// looks on the person's other hosts, then on their organizations' Solus APIs.

let sessionTools: typeof import('@solus/server/execution/agents/tools/session-tools')
let hostTools: typeof import('@solus/server/execution/agents/tools/host-tools')
let startTool: typeof import('@solus/server/execution/agents/tools/start-sessions-tool')['startSessionsAgentTool']
let hostDisplayName: typeof import('@solus/server/platform/host-display-name')['hostDisplayName']
let closeDb: typeof import('@solus/server/db')['closeDb']
let reachOfPrincipal: typeof import('@solus/server/execution/orchestration/remote-hosts')['reachOfPrincipal']
let withWorkspaceToolAuthority: typeof import('@solus/server/admission/workspace-tool-authority')['withWorkspaceToolAuthority']

const spawned: unknown[][] = []
const sentOrders: unknown[][] = []
const stopped: unknown[][] = []
const OWNER_REACH = { account: { userId: 'alice', scope: 'personal' as const }, isOwner: true }
/** What the current turn may reach; null for a person who reaches no other host from here. */
let turnReach: typeof OWNER_REACH | null = OWNER_REACH
const lookups: unknown[] = []
/** The organizations' Solus APIs the current turn may read. */
let turnApis: Array<{ organizationId: string; client: { request: (operation: string, input: { id: string }) => Promise<unknown> } }> = []
const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir = ''

const remoteHost = {
  hostId: 'host-b', installationId: 'install-b', label: 'Host B',
  api: {
    listProjects: async () => [{ key: 'k', path: '/srv/b/solus', folderName: 'solus', addedAt: '', lastUsedAt: '', repositoryKey: null }],
    start: async () => ({ agents: [{ id: 'codex', label: 'Codex', available: true, defaultModel: 'model-on-b', models: [{ id: 'model-on-b', label: 'B model' }] }] }),
    getSessionInfo: async (sessionId: string) => sessionId === 'thread-on-b'
      ? { provider: 'codex', sessionId: 'solus-on-b', slug: null, firstMessage: null, lastTimestamp: '2026-10-19T16:00:00Z', size: 1, cwd: '/srv/b/solus', projectPath: '/srv/b/solus', status: 'idle' }
      : null,
    loadSession: async (sessionId: string, _projectPath?: string, _ctx?: unknown, _provider?: string, limit?: number) => sessionId === 'solus-on-b'
      ? [{ role: 'user', content: 'Why did Codex ask?', timestamp: 1 }, { role: 'assistant', content: 'It ran without full access.', timestamp: 2 }].slice(-(limit ?? 2))
      : [],
  },
  call: (_what: string, request: () => Promise<unknown>) => request(),
}
const remoteHosts = {
  summaries: async (request: unknown) => {
    lookups.push(request)
    return [{ id: 'host-b', installationId: 'install-b', name: 'Host B', source: 'account', status: 'online', routes: [{ kind: 'tunnel', url: 'https://b.example' }] }]
  },
  list: async () => [{ hostId: 'host-b', label: 'Host B', routes: [{ kind: 'tunnel', url: 'https://b.example' }] }],
  find: async (request: unknown, ref: string) => {
    lookups.push(request)
    return ref === 'Host B' ? { hostId: 'host-b', label: 'Host B' } : { error: `No host "${ref}".` }
  },
  connect: () => remoteHost,
  async connectTo(request: unknown, ref: string) {
    const target = await this.find(request, ref)
    return 'error' in target ? target : this.connect()
  },
}

const ctx = { agentProvider: 'codex' as const, cwd: '/repo/on/a', sessionId: 'solus-parent' }
/** An outside app's requester key (plans/035 §8), and its call: no session, the app's person as the authority. */
const APP = 'client:grant-app'
const appContext = {
  provider: 'claude-code' as const, cwd: '/home/me', sessionId: () => undefined, requesterKey: () => APP, emit: () => {},
  abortSignal: new AbortController().signal, parentToolUseId: () => undefined,
}
const OWNER_APP: Principal = { kind: 'owner', via: 'local', deviceId: 'grant-app', deviceLabel: 'Claude Desktop', expiresAt: null }
const MEMBER_APP: Principal = {
  kind: 'org-member', userId: 'bob', organizationId: 'org-1', organizationRole: 'member', teamIds: [], hostKind: 'personal',
  displayName: 'Bob', deviceId: 'grant-bob', expiresAt: Date.now() + 60_000, deviceLabel: 'Cursor',
}
const GUEST_APP = { kind: 'guest', guestId: 'guest-1', displayName: 'Guest', deviceId: 'guest-1', expiresAt: Date.now() + 60_000, deviceLabel: 'Cursor' } as unknown as Principal
/** One tool, called by an outside app acting for `principal`. */
const asApp = <T>(principal: Principal, call: () => Promise<T>) => withWorkspaceToolAuthority(principal, call)
const toolContext = {
  provider: ctx.agentProvider, cwd: ctx.cwd, sessionId: () => ctx.sessionId, emit: () => {},
  abortSignal: new AbortController().signal, parentToolUseId: () => undefined,
}
/** start_sessions with one session on Host B, with `session`'s fields. */
const start = (session: object = {}) =>
  startTool.execute({ sessions: [{ prompt: 'Run the suite on B.', model_id: 'model-on-b', host: 'Host B', ...session }] }, toolContext)

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-tools-remote-'))
  process.env.SOLUS_DATA_DIR = dataDir
  sessionTools = await import('@solus/server/execution/agents/tools/session-tools')
  hostTools = await import('@solus/server/execution/agents/tools/host-tools')
  startTool = (await import('@solus/server/execution/agents/tools/start-sessions-tool')).startSessionsAgentTool
  ;({ hostDisplayName } = await import('@solus/server/platform/host-display-name'))
  ;({ closeDb } = await import('@solus/server/db'))
  ;({ reachOfPrincipal } = await import('@solus/server/execution/orchestration/remote-hosts'))
  ;({ withWorkspaceToolAuthority } = await import('@solus/server/admission/workspace-tool-authority'))
  sessionTools.setSessionController({
    permissionModeFor: () => 'supervised',
    getSessionInfo: async () => null,
    // A session's turn reaches as the test sets; an outside app's person by the host's one rule.
    reachRequestFor: (caller) => 'principal' in caller ? reachOfPrincipal(caller.principal, () => OWNER_REACH) : turnReach,
    organizationApisFor: () => turnApis,
    listAgentTargets: async () => [{
      provider: 'codex', label: 'Codex', available: true, defaultModel: 'model-on-a',
      models: [{ id: 'model-on-a', label: 'A model', reasoningLevels: [], defaultReasoningEffort: 'medium', defaultContextWindow: null }],
    }],
  } as never)
  sessionTools.setSessionOrchestration({
    spawn: async (...args) => { spawned.push(args); return { exchangeId: 'm-remote', sessionId: 'child-on-b' } },
    send: async (...args) => { sentOrders.push(args); return { exchangeId: 'm-sent-b', disposition: 'queued' } },
    readExchange: (_sender, exchangeId) => exchangeId === 'm-sent-b' ? { provider: 'codex' } as never : undefined,
    releaseRateLimit: () => false,
    stop: (...args) => { stopped.push(args); return true },
    remoteHostOf: (sender, target) => [ctx.sessionId, APP].includes(sender) && target === 'child-on-b' ? 'Host B' : undefined,
  })
})

afterAll(() => {
  sessionTools.setRemoteHosts(null)
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe('start_sessions on another host', () => {
  test('is refused on a host that cannot reach other hosts', async () => {
    sessionTools.setRemoteHosts(null)
    const result = await start({})
    expect(result).toEqual({ ok: false, text: 'sessions[0]: This host cannot reach other hosts. No session was started.' })
    expect(spawned).toHaveLength(0)
  })

  test('refuses a turn whose person reaches no other host', async () => {
    sessionTools.setRemoteHosts(remoteHosts as never)
    turnReach = null
    expect((await start({})).text).toContain('Only a person with access to this host')
    turnReach = OWNER_REACH
    expect(spawned).toHaveLength(0)
  })


  test('checks the model against the other host, not this one', async () => {
    sessionTools.setRemoteHosts(remoteHosts as never)
    const result = await start({ model_id: 'model-on-a' })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('(on Host B)')
    expect(spawned).toHaveLength(0)
  })

  test('starts in a new chat folder there, naming the session that started it', async () => {
    sessionTools.setRemoteHosts(remoteHosts as never)
    const result = await start({})
    expect(result.ok).toBe(true)
    expect(result.text).toContain('on Host B')
    expect(result.text).toContain('serverId=install-b')
    const [sender, order, , , , target] = spawned.at(-1)!
    expect(sender).toBe('solus-parent')
    expect(order).toMatchObject({ cwd: NEW_CHAT_DIRECTORY, modelId: 'model-on-b' })
    expect((target as RemoteTarget).host.hostId).toBe('host-b')
    expect((target as RemoteTarget).origin).toEqual({ kind: 'session', hostLabel: hostDisplayName(), sessionId: 'solus-parent' })
  })

  test('sends a path on the other host as written, unresolved', async () => {
    sessionTools.setRemoteHosts(remoteHosts as never)
    await start({ cwd: '~/code/app' })
    expect(spawned.at(-1)![1]).toMatchObject({ cwd: '~/code/app' })
  })
  test('looks the host up for the turn\'s person', async () => {
    sessionTools.setRemoteHosts(remoteHosts as never)
    lookups.length = 0
    await start({})
    expect(lookups).toEqual([OWNER_REACH])
  })
})

describe('a session on another host', () => {
  test('list_agent_targets still shows what that host offers when its project list fails', async () => {
    const listProjects = remoteHost.api.listProjects
    remoteHost.api.listProjects = async () => { throw new Error('forbidden') }
    try {
      sessionTools.setRemoteHosts(remoteHosts as never)
      const result = await sessionTools.executeSessionTool('list_agent_targets', { host: 'Host B' }, { ctx })
      expect(result.ok).toBe(true)
      const there = JSON.parse(result.text)
      expect(there.targets).toHaveLength(1)
      expect(there.projects).toBeUndefined()
    } finally {
      remoteHost.api.listProjects = listProjects
    }
  })

  test('list_agent_targets lists capabilities only, with list_hosts for machine discovery', async () => {
    sessionTools.setRemoteHosts(remoteHosts as never)
    const there = JSON.parse((await sessionTools.executeSessionTool('list_agent_targets', { host: 'Host B' }, { ctx })).text)
    expect(there).toMatchObject({ host: 'Host B', targets: [{ provider: 'codex', models: [{ id: 'model-on-b' }] }] })
    // The projects there are the only paths an agent here can know to pass as cwd.
    expect(there.projects).toEqual([{ name: 'solus', path: '/srv/b/solus' }])
    const here = JSON.parse((await sessionTools.executeSessionTool('list_agent_targets', {}, { ctx })).text)
    expect(here.targets).toHaveLength(1)
    expect(here.otherHosts).toBeUndefined()
    expect(here.hosts).toBeUndefined()
    lookups.length = 0
    const machines = JSON.parse((await sessionTools.executeSessionTool('list_hosts', {}, { ctx })).text)
    expect(machines.hosts).toEqual([{ id: 'host-b', installationId: 'install-b', name: 'Host B', source: 'account', status: 'online', routes: [{ kind: 'tunnel', url: 'https://b.example' }] }])
    expect(machines.targets).toBeUndefined()
    expect(lookups).toEqual([OWNER_REACH])
  })

  test('list_hosts refuses a turn that has no host access, and returns an empty list when no hosts are configured', async () => {
    turnReach = null
    try {
      const result = await sessionTools.executeSessionTool('list_hosts', {}, { ctx })
      expect(result.ok).toBe(false)
      expect(result.text).toContain('host access')
    } finally { turnReach = OWNER_REACH }
    sessionTools.setRemoteHosts(null)
    try {
      const result = await sessionTools.executeSessionTool('list_hosts', {}, { ctx })
      expect(result.ok).toBe(true)
      expect(JSON.parse(result.text)).toEqual({ hosts: [] })
    } finally { sessionTools.setRemoteHosts(remoteHosts as never) }
  })

  test('send_session sends to the host the session runs on, with the files it attached', async () => {
    // WHY: the session is not on this host, so it is never looked up here; the
    // orchestrator gets that host as the target and the files to upload there.
    sessionTools.setRemoteHosts(remoteHosts as never)
    writeFileSync(join(dataDir, 'notes.txt'), 'notes')
    const result = await sessionTools.executeSessionTool('send_session', { session_id: 'child-on-b', message: 'More work.', attachments: [join(dataDir, 'notes.txt')] }, { ctx })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('Queued for')
    expect(result.text).toContain('serverId=install-b')
    expect(result.text).toContain('on Host B')
    const [sender, target, order, remote] = sentOrders.at(-1)!
    expect([sender, target]).toEqual(['solus-parent', 'child-on-b'])
    expect(order).toMatchObject({ prompt: 'More work.', attachments: [join(dataDir, 'notes.txt')] })
    expect((remote as RemoteTarget).host.hostId).toBe('host-b')
  })

  test('send_session to another host is refused for a turn whose person reaches no other host', async () => {
    // WHY: host B is reached for the turn's person. In a shared session, a person
    // with no reach must not act through anyone else's.
    sessionTools.setRemoteHosts(remoteHosts as never)
    turnReach = null
    const before = sentOrders.length
    const result = await sessionTools.executeSessionTool('send_session', { session_id: 'child-on-b', message: 'More work.' }, { ctx })
    turnReach = OWNER_REACH
    expect(result).toEqual({ ok: false, text: 'Only a person with access to this host can reach their other hosts from it.' })
    expect(sentOrders).toHaveLength(before)
  })

  test('send_session to another host is refused here when this host cannot reach it', async () => {
    sessionTools.setRemoteHosts(null)
    const before = sentOrders.length
    const result = await sessionTools.executeSessionTool('send_session', { session_id: 'child-on-b', message: 'More work.' }, { ctx })
    expect(result).toEqual({ ok: false, text: 'This host cannot reach other hosts.' })
    expect(sentOrders).toHaveLength(before)
  })

  test('send_session refuses to release a rate limit on another host', async () => {
    // WHY: the hold is on the host that runs the session; this host cannot release it,
    // and a message sent anyway would wait for the old reset with no word of it.
    sessionTools.setRemoteHosts(remoteHosts as never)
    const before = sentOrders.length
    const result = await sessionTools.executeSessionTool('send_session', { session_id: 'child-on-b', message: 'Continue.', release_rate_limit: true }, { ctx })
    expect(result).toEqual({ ok: false, text: 'release_rate_limit works only for a session on this host.' })
    expect(sentOrders).toHaveLength(before)
  })

  test('stop_session asks the orchestrator to stop it there', async () => {
    const result = await sessionTools.executeSessionTool('stop_session', { session_id: 'child-on-b' }, { ctx })
    expect(result.text).toContain('Asked Host B to stop session child-on-b')
    expect(stopped.at(-1)).toEqual(['solus-parent', 'child-on-b'])
  })
})

describe('read_session of a session this host does not hold', () => {
  const organizationApi = {
    organizationId: 'org-1',
    client: {
      request: async (operation: string, input: { id: string }) => {
        if (input.id !== 'solus-in-org') throw new Error('Not found')
        if (operation === 'getSession') return { id: 'solus-in-org', provider: 'codex', slug: null, title: 'Cloud run', customTitle: null, projectPath: '/work/app', cwd: '/work/app', status: 'idle', size: 3, model: null, reasoningEffort: null, organizationId: 'org-1', updatedAt: '2026-10-19T16:00:00Z' }
        // One message the API stored in two parts, then a second message.
        return { items: [
          { messageId: 'm1', role: 'user', timestamp: '2026-10-19T16:00:00Z', content: 'Ship ', contentOffset: 0, isLastPart: false, toolName: null, parentToolUseId: null },
          { messageId: 'm1', role: 'user', timestamp: '2026-10-19T16:00:00Z', content: 'it.', contentOffset: 5, isLastPart: true, toolName: null, parentToolUseId: null },
          { messageId: 'm2', role: 'assistant', timestamp: '2026-10-19T16:00:01Z', content: 'Shipped.', contentOffset: 0, isLastPart: true, toolName: null, parentToolUseId: null },
        ], nextCursor: null }
      },
    },
  }

  test('reads it from the other host that holds it, with a link that opens it there', async () => {
    // WHY: a person's sessions run on all their linked machines. A thread id from
    // another machine must read like one here, not answer "not found".
    sessionTools.setRemoteHosts(remoteHosts as never)
    turnApis = [organizationApi]
    const result = await sessionTools.executeSessionTool('read_session', { session_id: 'thread-on-b' }, { ctx })
    turnApis = []
    expect(result.ok).toBe(true)
    const read = JSON.parse(result.text)
    expect(read.session.foundOn).toBe('Host B')
    expect(read.session.link).toContain('sessionId=solus-on-b&serverId=install-b')
    expect(read.items.map((item: { text: string }) => item.text)).toContain('It ran without full access.')
  })

  test('reads it from an organization\'s Solus API when no host has it', async () => {
    sessionTools.setRemoteHosts(remoteHosts as never)
    turnApis = [organizationApi]
    // The item id a search names opens that message, here one the API stored in two parts.
    const result = await sessionTools.executeSessionTool('read_session', { session_id: 'solus-in-org', item_id: 'm1' }, { ctx })
    turnApis = []
    expect(result.ok).toBe(true)
    const read = JSON.parse(result.text)
    expect(read.session.foundOn).toBe('the Solus API of organization org-1')
    expect(read.items).toEqual([expect.objectContaining({ itemId: 'm1', type: 'user_message', text: 'Ship it.' })])
  })

  test('says where it looked when no one has it', async () => {
    sessionTools.setRemoteHosts(remoteHosts as never)
    const result = await sessionTools.executeSessionTool('read_session', { session_id: 'nowhere' }, { ctx })
    expect(result).toEqual({ ok: false, text: "Session nowhere not found on this host, your other hosts, or your organizations' Solus APIs." })
  })
})

test('a child across hosts retains child ownership, isolation, and permission limits', async () => {
  sessionTools.setRemoteHosts(remoteHosts as never)
  const result = await startTool.execute({ sessions: [{ prompt: 'Review on B', cwd: '~/code/app', worktree_base_branch: 'main', host: 'Host B', agent_provider: 'codex', isolation: 'worktree' }] }, {
    ...toolContext, provider: 'claude-code',
  })
  expect(result.ok).toBe(true)
  expect(spawned.at(-1)?.[1]).toMatchObject({ independent: false, provider: 'codex', modelId: 'model-on-b', cwd: '~/code/app', worktreeBaseBranch: 'main', permissionMode: 'supervised' })
  expect(spawned.at(-1)?.[2]).toBe(true)
})

describe('an outside app on another host (plans/035 §0.6)', () => {
  // WHY: an app connected to this host reaches the person's other hosts as an agent
  // here does, for the person who approved it: the owner their own hosts, a member
  // only through their organization, a guest none. The work it starts there names
  // no session, reports to nobody, and is reached again only by the same app.

  test('the owner\'s app lists hosts and starts a session on one, with no session origin and no report', async () => {
    sessionTools.setRemoteHosts(remoteHosts as never)
    lookups.length = 0
    const listed = await asApp(OWNER_APP, () => hostTools.listHostsAgentTool.execute({}, appContext))
    expect(listed.ok).toBe(true)
    expect(JSON.parse(listed.text).hosts.map((host: { name: string }) => host.name)).toEqual(['Host B'])

    const result = await asApp(OWNER_APP, () => startTool.execute({ sessions: [{ prompt: 'Run the suite on B.', agent_provider: 'codex', model_id: 'model-on-b', host: 'Host B' }] }, appContext))
    expect(result.ok).toBe(true)
    expect(result.text).toContain('read_session_exchange with exchange_id=m-remote')
    const [sender, order, report, , , target] = spawned.at(-1)!
    expect(sender).toBe(APP)
    expect(report).toBe(false)
    expect((target as RemoteTarget).host.hostId).toBe('host-b')
    expect((target as RemoteTarget).origin).toBeUndefined()
    // The mode it would start in here, by this host's policy: nothing limits it in this test.
    expect(order).toMatchObject({ permissionMode: 'full-access' })
    expect(lookups).toEqual([OWNER_REACH, OWNER_REACH])
  })

  test('a member\'s app reaches only through its organization', async () => {
    sessionTools.setRemoteHosts(remoteHosts as never)
    lookups.length = 0
    await asApp(MEMBER_APP, () => hostTools.listHostsAgentTool.execute({}, appContext))
    await asApp(MEMBER_APP, () => startTool.execute({ sessions: [{ prompt: 'Org work on B.', agent_provider: 'codex', model_id: 'model-on-b', host: 'Host B' }] }, appContext))
    const memberReach = { account: { userId: 'bob', scope: { organizationId: 'org-1' } }, isOwner: false }
    expect(lookups).toEqual([memberReach, memberReach])
  })

  test('an app whose person reaches no other host is refused, and nothing starts', async () => {
    sessionTools.setRemoteHosts(remoteHosts as never)
    const before = spawned.length
    const listed = await asApp(GUEST_APP, () => hostTools.listHostsAgentTool.execute({}, appContext))
    expect(listed).toEqual({ ok: false, text: 'Only a person with host access can list their other hosts.' })
    const started = await asApp(GUEST_APP, () => startTool.execute({ sessions: [{ prompt: 'Work on B.', agent_provider: 'codex', model_id: 'model-on-b', host: 'Host B' }] }, appContext))
    expect(started).toEqual({ ok: false, text: 'sessions[0]: Only a person with access to this host can reach their other hosts from it. No session was started.' })
    expect(spawned).toHaveLength(before)
  })

  test('an app with read access lists hosts, but cannot start, message, or stop a session there', async () => {
    const { appToolRefusal } = await import('@solus/server/execution/agents/tools/tool-access')
    expect(appToolRefusal(hostTools.listHostsAgentTool, 'read')).toBeNull()
    for (const tool of [startTool, sessionTools.sendSessionAgentTool, sessionTools.stopSessionAgentTool]) {
      expect(appToolRefusal(tool, 'read')).toContain('approved to read only')
      expect(appToolRefusal(tool, 'write')).toBeNull()
    }
  })

  test('the session it started there is messaged, read, and stopped there, as the app', async () => {
    sessionTools.setRemoteHosts(remoteHosts as never)
    const sent = await asApp(OWNER_APP, () => sessionTools.sendSessionAgentTool.execute({ session_id: 'child-on-b', message: 'More work.' }, appContext))
    expect(sent.ok).toBe(true)
    expect(sent.text).toContain('on Host B')
    const [sender, targetId, order, remote] = sentOrders.at(-1)!
    expect([sender, targetId]).toEqual([APP, 'child-on-b'])
    expect(order).toMatchObject({ notify: false })
    expect((remote as RemoteTarget).origin).toBeUndefined()

    const read = await asApp(OWNER_APP, () => sessionTools.readSessionAgentTool.execute({ session_id: 'thread-on-b' }, appContext))
    expect(JSON.parse(read.text).session.foundOn).toBe('Host B')

    const stop = await asApp(OWNER_APP, () => sessionTools.stopSessionAgentTool.execute({ session_id: 'child-on-b' }, appContext))
    expect(stop.text).toContain('Asked Host B to stop session child-on-b')
    expect(stopped.at(-1)).toEqual([APP, 'child-on-b'])
  })

  test('the app gets no broader mode there than here: this host\'s ceiling applies first', async () => {
    const { HostPolicyStore, useHostPolicyStore } = await import('@solus/server/host/policy/host-policy-store')
    const document = { schemaVersion: 1 as const, organization: { name: 'Example Corp' }, sessions: { limits: { maxPermissionMode: 'supervised' as const } } }
    useHostPolicyStore(new HostPolicyStore({ mdm: { source: 'test', document, fingerprint: 'test' }, standing: () => null }))
    sessionTools.setRemoteHosts(remoteHosts as never)
    const before = spawned.length
    try {
      // With no mode, the default here, lowered to the ceiling here.
      await asApp(OWNER_APP, () => startTool.execute({ sessions: [{ prompt: 'Work on B.', agent_provider: 'codex', model_id: 'model-on-b', host: 'Host B' }] }, appContext))
      expect(spawned.at(-1)![1]).toMatchObject({ permissionMode: 'supervised' })
      // A mode above the ceiling here is refused here, before host B is asked.
      const refused = await asApp(OWNER_APP, () => startTool.execute({ sessions: [{ prompt: 'Work on B.', agent_provider: 'codex', model_id: 'model-on-b', host: 'Host B', permission_mode: 'full-access' }] }, appContext))
      expect(refused.ok).toBe(false)
      expect(refused.text).toContain('Supervised')
      expect(spawned).toHaveLength(before + 1)
    } finally {
      useHostPolicyStore(new HostPolicyStore({ mdm: null, standing: () => null }))
    }
  })
})

describe('the reach rule that a turn and an app share', () => {
  test('the owner reaches as the owner, a member through their organization, anyone else nothing', () => {
    const ownerReach = () => OWNER_REACH
    expect(reachOfPrincipal(OWNER_APP, ownerReach)).toEqual(OWNER_REACH)
    expect(reachOfPrincipal(MEMBER_APP, ownerReach)).toEqual({ account: { userId: 'bob', scope: { organizationId: 'org-1' } }, isOwner: false })
    expect(reachOfPrincipal(GUEST_APP, ownerReach)).toBeNull()
  })

  test('a member reads only their own organization\'s Solus API; the owner, and the host\'s own work, the owner\'s', async () => {
    const { organizationApisOf } = await import('@solus/server/execution/orchestration/remote-session-read')
    const holders = [
      { userId: 'alice', scope: 'personal' as const },
      { userId: 'alice', scope: { organizationId: 'org-a' } },
      { userId: 'bob', scope: { organizationId: 'org-1' } },
      { userId: 'bob', scope: { organizationId: 'org-2' } },
    ]
    const ids = (principal: Principal | null) => organizationApisOf(principal, holders, () => ({}) as never).map((api) => api.organizationId)
    expect(ids(OWNER_APP)).toEqual(['org-a'])
    expect(ids(null)).toEqual(['org-a'])
    expect(ids({ ...MEMBER_APP, organizationId: 'org-1' } as Principal)).toEqual(['org-1'])
    expect(ids(GUEST_APP)).toEqual([])
  })
})
