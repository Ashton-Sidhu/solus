import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import type { RemoteTarget } from '@solus/server/execution/orchestration/session-orchestrator'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// WHY: `start_session` with `host` starts the work on another host the turn's person
// reaches, as if they started it there (docs/plans/cross-host-sessions.md,
// docs/plans/host-reach.md). The tool must refuse what it cannot honour — no way to
// reach other hosts here, a task across hosts, a turn whose person reaches no other
// host — before it reaches the other host; it must look the host up for that person; check the model against what that host offers, not
// this one; never resolve the other host's path here; and tell the other host
// which session started it. A message to a session it started there goes to
// that host, with its attachments; a read names the host rather than "not found".

let sessionTools: typeof import('@solus/server/execution/agents/tools/session-tools')
let hostDisplayName: typeof import('@solus/server/platform/host-display-name')['hostDisplayName']
let closeDb: typeof import('@solus/server/db')['closeDb']

const spawned: unknown[][] = []
const sentOrders: unknown[][] = []
const stopped: unknown[][] = []
const OWNER_REACH = { account: { userId: 'alice', scope: 'personal' as const }, isOwner: true }
/** What the current turn may reach; null for a person who reaches no other host from here. */
let turnReach: typeof OWNER_REACH | null = OWNER_REACH
const lookups: unknown[] = []
const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir = ''

const remoteHost = {
  hostId: 'host-b', installationId: 'install-b', label: 'Host B',
  api: {
    start: async () => ({ agents: [{ id: 'codex', label: 'Codex', available: true, defaultModel: 'model-on-b', models: [{ id: 'model-on-b', label: 'B model' }] }] }),
  },
  call: (_what: string, request: () => Promise<unknown>) => request(),
}
const remoteHosts = {
  list: async () => [{ hostId: 'host-b', label: 'Host B', routes: [{ kind: 'tunnel', url: 'https://b.example' }] }],
  find: async (request: unknown, ref: string) => {
    lookups.push(request)
    return ref === 'Host B' ? { hostId: 'host-b', label: 'Host B' } : { error: `No host "${ref}".` }
  },
  connect: () => remoteHost,
}

const ctx = { agentProvider: 'codex' as const, cwd: '/repo/on/a', sessionId: 'solus-parent' }
const start = (args: Record<string, string | boolean>) => sessionTools.executeSessionTool('start_session', { model_id: 'model-on-b', prompt: 'Run the suite on B.', task: 'none', host: 'Host B', ...args }, { ctx })

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-session-tools-remote-'))
  process.env.SOLUS_DATA_DIR = dataDir
  sessionTools = await import('@solus/server/execution/agents/tools/session-tools')
  ;({ hostDisplayName } = await import('@solus/server/platform/host-display-name'))
  ;({ closeDb } = await import('@solus/server/db'))
  sessionTools.setSessionController({
    getSessionInfo: async () => null,
    reachRequestFor: () => turnReach,
    listAgentTargets: async () => [{
      provider: 'codex', label: 'Codex', available: true, defaultModel: 'model-on-a',
      models: [{ id: 'model-on-a', label: 'A model', reasoningLevels: [], defaultReasoningEffort: 'medium', defaultContextWindow: null }],
    }],
  } as never)
  sessionTools.setSessionOrchestration({
    spawn: async (...args) => { spawned.push(args); return { exchangeId: 'm-remote', sessionId: 'child-on-b' } },
    send: async (...args) => { sentOrders.push(args); return { exchangeId: 'm-sent-b', disposition: 'queued' } },
    readExchange: (_sender, exchangeId) => exchangeId === 'm-sent-b' ? { provider: 'codex' } as never : undefined,
    stop: (...args) => { stopped.push(args); return true },
    remoteHostOf: (sender, target) => sender === 'solus-parent' && target === 'child-on-b' ? 'Host B' : undefined,
  })
})

afterAll(() => {
  sessionTools.setRemoteHosts(null)
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

describe('start_session on another host', () => {
  test('is refused on a host that cannot reach other hosts', async () => {
    sessionTools.setRemoteHosts(null)
    const result = await start({})
    expect(result).toEqual({ ok: false, text: 'This host cannot reach other hosts.' })
    expect(spawned).toHaveLength(0)
  })

  test('refuses a task across hosts and a turn whose person reaches no other host', async () => {
    sessionTools.setRemoteHosts(remoteHosts as never)
    expect((await start({ task: 'attempt' })).text).toContain("Use task='none'")
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

  test('starts in a new chat folder there, with no task, naming the session that started it', async () => {
    sessionTools.setRemoteHosts(remoteHosts as never)
    const result = await start({})
    expect(result.ok).toBe(true)
    expect(result.text).toContain('on Host B')
    expect(result.text).toContain('serverId=install-b')
    const [sender, order, , , , target] = spawned.at(-1)!
    expect(sender).toBe('solus-parent')
    expect(order).toMatchObject({ cwd: NEW_CHAT_DIRECTORY, modelId: 'model-on-b', taskId: null })
    expect((target as RemoteTarget).host.hostId).toBe('host-b')
    expect((target as RemoteTarget).origin).toEqual({ hostLabel: hostDisplayName(), sessionId: 'solus-parent' })
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
  test('list_agent_targets shows what that host offers, and this host lists the other hosts', async () => {
    sessionTools.setRemoteHosts(remoteHosts as never)
    const there = JSON.parse((await sessionTools.executeSessionTool('list_agent_targets', { host: 'Host B' }, { ctx })).text)
    expect(there).toMatchObject({ host: 'Host B', targets: [{ provider: 'codex', models: [{ id: 'model-on-b' }] }] })
    const here = JSON.parse((await sessionTools.executeSessionTool('list_agent_targets', {}, { ctx })).text)
    expect(here.otherHosts).toEqual([{ id: 'host-b', name: 'Host B' }])
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

  test('stop_session asks the orchestrator to stop it there', async () => {
    const result = await sessionTools.executeSessionTool('stop_session', { session_id: 'child-on-b' }, { ctx })
    expect(result.text).toContain('Asked Host B to stop session child-on-b')
    expect(stopped.at(-1)).toEqual(['solus-parent', 'child-on-b'])
  })
})
