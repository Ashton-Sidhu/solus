import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import type { RemoteTarget } from '@solus/server/execution/orchestration/session-orchestrator'

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

// WHY: `start_session` with `host` starts the work on another of the owner's
// hosts as if the owner started it there (docs/plans/cross-host-sessions.md).
// The tool must refuse what the first version cannot honour — no account or pairing on
// this host, a task across hosts, a turn that is not the owner's — before it
// reaches the other host; check the model against what that host offers, not
// this one; never resolve the other host's path here; and tell the other host
// which session started it. A message to a session it started there goes to
// that host, with its attachments; a read names the host rather than "not found".

let sessionTools: typeof import('@solus/server/execution/agents/tools/session-tools')
let hostDisplayName: typeof import('@solus/server/platform/host-display-name')['hostDisplayName']
let closeDb: typeof import('@solus/server/db')['closeDb']

const spawned: unknown[][] = []
const sentOrders: unknown[][] = []
const stopped: unknown[][] = []
let ownerTurn = true
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
  find: async (ref: string) => ref === 'Host B' ? { hostId: 'host-b', label: 'Host B' } : { error: `No host "${ref}".` },
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
    actsForHostOwner: () => ownerTurn,
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
  test('is refused on a host with no account session and no paired host', async () => {
    sessionTools.setRemoteHosts(null)
    const result = await start({})
    expect(result).toEqual({ ok: false, text: expect.stringContaining('Pair a host in Settings → Hosts → this host → Access') })
    expect(spawned).toHaveLength(0)
  })

  test('refuses a task across hosts and a turn that is not the owner\'s', async () => {
    sessionTools.setRemoteHosts(remoteHosts as never)
    expect((await start({ task: 'attempt' })).text).toContain("Use task='none'")
    ownerTurn = false
    expect((await start({})).text).toContain("Only this host's owner")
    ownerTurn = true
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

  test('send_session to another host is refused for a turn that is not the owner\'s', async () => {
    // WHY: host B is reached with the owner's token. In a shared session,
    // another person's turn must not act as the owner there.
    sessionTools.setRemoteHosts(remoteHosts as never)
    ownerTurn = false
    const before = sentOrders.length
    const result = await sessionTools.executeSessionTool('send_session', { session_id: 'child-on-b', message: 'More work.' }, { ctx })
    ownerTurn = true
    expect(result).toEqual({ ok: false, text: "Only this host's owner can message sessions on their other hosts." })
    expect(sentOrders).toHaveLength(before)
  })

  test('send_session to another host is refused here when this host cannot reach it', async () => {
    sessionTools.setRemoteHosts(null)
    const before = sentOrders.length
    const result = await sessionTools.executeSessionTool('send_session', { session_id: 'child-on-b', message: 'More work.' }, { ctx })
    expect(result).toEqual({ ok: false, text: expect.stringContaining('Only a host signed in to your Solus account') })
    expect(sentOrders).toHaveLength(before)
  })

  test('stop_session asks the orchestrator to stop it there', async () => {
    const result = await sessionTools.executeSessionTool('stop_session', { session_id: 'child-on-b' }, { ctx })
    expect(result.text).toContain('Asked Host B to stop session child-on-b')
    expect(stopped.at(-1)).toEqual(['solus-parent', 'child-on-b'])
  })
})
