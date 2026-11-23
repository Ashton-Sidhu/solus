import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import type { SessionDigest } from '@solus/contracts/session-digest'
import type { Principal } from '@solus/server/admission/principal'
import { asHostApi } from '@solus/client-core/host-api'
import { HostEventSubscriber } from '@solus/client-core/host-event-subscriber'
import { DatabaseSync } from './helpers/bun-sqlite'
import { resetTestDatabase } from './helpers/test-db'

/**
 * A session tree is read from the database alone: each node's record, its
 * stored digest, and its artifacts (docs/plans/session-digests.md).
 */

mock.module('node:sqlite', () => ({ DatabaseSync }))

let directory: string
const previous = process.env.SOLUS_DATA_DIR

function digestOf(sessionId: string, prompt: string): SessionDigest {
  return {
    sessionId,
    turns: [{ id: `${sessionId}-turn`, startedAt: 1, endedAt: 2, settled: true, prompt, toolCalls: [[0, 3]], changes: { filesChanged: 1, additions: 2, deletions: 0 } }],
    changes: { files: [{ path: `${sessionId}.ts`, additions: 2, deletions: 0, status: 'A' }], filesChanged: 1, additions: 2, deletions: 0 },
    subagents: [{ id: 'agent', title: 'Audit', status: 'completed', startedAt: 1, endedAt: 2, detail: 'Fine.' }],
    lastReply: `${prompt} done.`,
    updatedAt: 2,
  }
}

beforeAll(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'solus-session-tree-')))
  process.env.SOLUS_DATA_DIR = directory
  const { getDatabase } = await import('@solus/server/db/database')
  await getDatabase().run(sql`
    INSERT INTO session_records(session_id, organization_id, created_by, provider, project_path, cwd, status, parent_session_id, created_at, last_activity_at, started_at)
    VALUES
      ('lead', 'local', 'owner', 'codex', ${directory}, ${directory}, 'idle', NULL, 1, 9, 1),
      ('child-b', 'local', 'owner', 'codex', ${directory}, ${directory}, 'idle', 'lead', 3, 3, 1),
      ('child-a', 'local', 'owner', 'claude-code', ${directory}, ${directory}, 'idle', 'lead', 2, 2, 1),
      ('grandchild', 'local', 'owner', 'codex', ${directory}, ${directory}, 'idle', 'child-a', 4, 4, 1)
  `)
})

afterAll(async () => {
  await resetTestDatabase()
  rmSync(directory, { recursive: true, force: true })
  if (previous === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previous
})

test('each node carries its own record, stored digest, and artifacts', async () => {
  // WHY: the parent's Threads surface shows what each child did and linked
  // from the child's own rows, with no transcript and no checkout.
  const { readSessionTree, writeSessionDigest } = await import('@solus/server/data/sessions/session-digests')
  const { linkSessionItem } = await import('@solus/server/data/sessions/session-links')
  await writeSessionDigest(digestOf('lead', 'Plan'))
  await writeSessionDigest(digestOf('child-a', 'Build'))
  await writeSessionDigest(digestOf('grandchild', 'Test'))
  await linkSessionItem('child-a', { target: { kind: 'file', path: '/tmp/plan.md', hostId: 'host-1' } }, { kind: 'system' })

  const tree = await readSessionTree('local', 'lead')
  expect(tree.nodes.map((node) => node.record.sessionId)).toEqual(['lead', 'child-a', 'child-b', 'grandchild'])
  const child = tree.nodes[1]
  expect(child.digest).toEqual(digestOf('child-a', 'Build'))
  expect(child.artifacts).toEqual([expect.objectContaining({ kind: 'file', path: '/tmp/plan.md' })])
  expect(tree.nodes[0].artifacts).toEqual([])
  // A session that did nothing yet has no digest: unknown, not empty.
  expect(tree.nodes[2].digest).toBeNull()
  // A child's tree is its own subtree.
  expect((await readSessionTree('local', 'child-a')).nodes.map((node) => node.record.sessionId)).toEqual(['child-a', 'grandchild'])
  // Another organization does not read these sessions.
  expect((await readSessionTree('organization-B', 'lead')).nodes).toEqual([])
})

test('a subtree another host runs is stored under its local parent and read with the tree', async () => {
  // WHY: a child on another host is in its parent's tree from this host's
  // database, also while that host is offline, and its pull requests are a copy
  // that starts no PR sync here.
  const { readSessionTree, storeRemoteSessionTree } = await import('@solus/server/data/sessions/session-digests')
  const remoteRecord = (sessionId: string, parentSessionId: string) => ({
    sessionId, provider: 'codex' as const, projectPath: '/remote/project', lastActivityAt: 7, createdAt: 7,
    runnerHostId: 'host-b', parentSessionId, title: `Remote ${sessionId}`, status: 'idle' as const,
  })
  const pullRequest = {
    kind: 'pull-request' as const,
    link: { sessionId: 'remote-child', repository: 'github.com/acme/app', number: 7, url: 'https://github.com/acme/app/pull/7', title: 'Fix', source: 'agent' as const, linkedAt: 7 },
  }
  await storeRemoteSessionTree('child-b', [
    { record: remoteRecord('remote-child', 'child-b'), digest: digestOf('remote-child', 'Remote work'), artifacts: [pullRequest] },
    { record: remoteRecord('remote-grandchild', 'remote-child'), digest: null, artifacts: [] },
  ])

  const tree = await readSessionTree('local', 'lead')
  expect(tree.nodes.map((node) => node.record.sessionId)).toEqual(['lead', 'child-a', 'child-b', 'grandchild', 'remote-child', 'remote-grandchild'])
  const remote = tree.nodes[4]
  expect(remote.record).toMatchObject({ runnerHostId: 'host-b', parentSessionId: 'child-b', organizationId: 'local', ownerKey: 'owner' })
  expect(remote.digest).toEqual(digestOf('remote-child', 'Remote work'))
  expect(remote.artifacts).toEqual([pullRequest])
  const { getDatabase } = await import('@solus/server/db/database')
  expect(await getDatabase().all(sql`SELECT source_id FROM resource_links WHERE source_id = 'remote-child'`)).toEqual([])
  // A parent this host does not have stores nothing.
  await storeRemoteSessionTree('not-here', [{ record: remoteRecord('orphan', 'not-here'), digest: null, artifacts: [] }])
  expect(await getDatabase().all(sql`SELECT session_id FROM session_records WHERE session_id = 'orphan'`)).toEqual([])
})

test('a new digest replaces the stored one, and a session delete removes it', async () => {
  const { readSessionDigests, writeSessionDigest } = await import('@solus/server/data/sessions/session-digests')
  const { deleteSessionRecord } = await import('@solus/server/data/sessions/session-records')
  await writeSessionDigest({ ...digestOf('grandchild', 'Test again'), updatedAt: 5 })
  expect((await readSessionDigests('local', ['grandchild'])).get('grandchild')?.lastReply).toBe('Test again done.')
  await deleteSessionRecord('local', 'grandchild')
  expect((await readSessionDigests('local', ['grandchild'])).has('grandchild')).toBe(false)
})

test('fork links resolve the provider source to its saved Solus session in both directions', async () => {
  const { appendActivity, newActivity } = await import('@solus/server/data/activity/activity')
  const { registerSessionLineage, replaceSessionLineageThread } = await import('@solus/server/data/sessions/session-lineage')
  const { sessionTreeRelations } = await import('@solus/server/data/sessions/session-tree-relations')
  const { getSessionRecord } = await import('@solus/server/data/sessions/session-records')

  registerSessionLineage({ sessionId: 'lead', providerSessionId: 'provider-lead', provider: 'codex', cwd: directory })
  await appendActivity('local', newActivity(
    { kind: 'session', id: 'child-b' }, { kind: 'system' }, { kind: 'forked', sourceSessionId: 'provider-lead' }, 1,
  ))
  await appendActivity('unrelated-organization', newActivity(
    { kind: 'session', id: 'child-a' }, { kind: 'system' }, { kind: 'forked', sourceSessionId: 'provider-lead' }, 2,
  ))
  replaceSessionLineageThread({
    sessionId: 'lead', provider: 'codex', sourceThreadId: 'provider-lead',
    providerSessionId: 'moved-lead', cwd: directory,
  })
  const lead = await getSessionRecord('local', 'lead')
  const fork = await getSessionRecord('local', 'child-b')
  expect(await sessionTreeRelations('local', lead!)).toMatchObject([{ kind: 'fork', sessionId: 'child-b' }])
  expect(await sessionTreeRelations('local', fork!)).toMatchObject([{ kind: 'fork-source', sessionId: 'lead' }])
})

test('read-only remote history requires an exact child link and independent read access', async () => {
  const { INTERNAL_HANDLER_CTX, SolusServer } = await import('@solus/server/transport/server')
  const { registerSessionLineageHandlers } = await import('@solus/server/transport/handlers/session-lineage-handlers')
  const server = new SolusServer()
  let dials = 0
  server.register('getSessionInfo', () => null)
  registerSessionLineageHandlers(server, { stopSessionSubagent: async () => false }, {
    connectTo: async (_reach, hostId) => {
      dials++
      expect(hostId).toBe('host-b')
      return {
        hostId, installationId: hostId, label: 'Worker',
        api: asHostApi({
          loadSessionPage: async () => ({
            before: 'older',
            messages: [
              { role: 'tool', timestamp: 1, content: 'Tool data' },
              { role: 'assistant', timestamp: 2, content: 'Child answer', imageAttachmentRefs: [{ path: '/remote' }] },
            ],
          }),
        }),
        events: new HostEventSubscriber(),
        onReconnected: () => () => {},
        call: (_label, request) => request(),
      }
    },
  }, () => ({ account: null, isOwner: true }))
  await expect(server.handle('sessionLineageHistory', ['lead', 'remote-child'], INTERNAL_HANDLER_CTX)).rejects.toThrow('not a remote child')
  expect(dials).toBe(0)
  expect(await server.handle('sessionLineageHistory', ['child-b', 'remote-child'], INTERNAL_HANDLER_CTX)).toEqual({
    before: 'older', messages: [{ role: 'assistant', timestamp: 2, content: 'Child answer', messageId: undefined }],
  })
  const { installTestIdentities } = await import('./helpers/acting-identities')
  installTestIdentities()
  const accessChecks: string[] = []
  server.useResourceAccess({ standingFor: async (_principal, target) => {
    accessChecks.push(target.id)
    return { role: target.id === 'child-b' ? 'viewer' : 'none' }
  } })
  const principal: Principal = {
    kind: 'guest', guestId: 'guest', displayName: 'Guest', deviceId: 'guest', expiresAt: 0,
    deviceLabel: 'Guest', organizationId: 'local',
    share: { resource: { kind: 'session', id: 'child-b' }, role: 'viewer', sharedByUserId: 'local:owner', linkSecretHash: 'test' },
  }
  await expect(server.handle('sessionLineageHistory', ['child-b', 'remote-child'], { clientId: 'test', principal })).rejects.toThrow('not shared')
  expect(accessChecks).toEqual(['child-b', 'remote-child'])
  expect(dials).toBe(1)
})

test('merge back includes completed fork work and omits inherited, failed, and unfinished messages', async () => {
  const { INTERNAL_HANDLER_CTX, SolusServer } = await import('@solus/server/transport/server')
  const { registerSessionLineageHandlers } = await import('@solus/server/transport/handlers/session-lineage-handlers')
  const { writeSessionDigest } = await import('@solus/server/data/sessions/session-digests')
  const server = new SolusServer()
  registerSessionLineageHandlers(server, { stopSessionSubagent: async () => false }, {
    connectTo: async () => { throw new Error('Unexpected remote connection') },
  }, () => null)
  server.register('getSessionInfo', () => null)
  server.register('loadSessionPage', ([request]) => {
    expect(request.sessionId).toBe('child-b')
    return { before: null, messages: [
      { role: 'user', timestamp: 0, content: 'Inherited prompt' },
      { role: 'assistant', timestamp: 2, content: 'Failed finding' },
      { role: 'assistant', timestamp: 6, content: 'Fork finding' },
      { role: 'assistant', timestamp: 9, content: 'Unfinished finding' },
    ] }
  })
  const digest = digestOf('child-b', 'Inspect')
  const turn = digest.turns[0]!
  await writeSessionDigest({
    ...digest,
    turns: [
      { ...turn, id: 'failed', startedAt: 1, endedAt: 3, outcome: 'failed' },
      { ...turn, id: 'completed', startedAt: 4, endedAt: 7, outcome: 'completed' },
      { ...turn, id: 'open', startedAt: 8, endedAt: 9, settled: false },
    ],
  })
  const result = await server.handle('sessionMergeBackPrompt', ['child-b'], INTERNAL_HANDLER_CTX)
  expect(result.target).toMatchObject({ kind: 'fork-source', sessionId: 'lead' })
  expect(result.prompt).toContain('Fork finding')
  expect(result.prompt).not.toContain('Inherited prompt')
  expect(result.prompt).not.toContain('Failed finding')
  expect(result.prompt).not.toContain('Unfinished finding')
})

test('a child turn has the same saved state before its digest exists, after a restart, and when a new turn starts', async () => {
  const { readSessionTree } = await import('@solus/server/data/sessions/session-digests')
  const { readSessionExecution, interruptOwnSessionExecutions } = await import('@solus/server/data/sessions/session-executions')
  const { SessionExecutionRecorder } = await import('@solus/server/execution/sessions/session-execution-recorder')
  const { upsertOwnSessionRecord } = await import('@solus/server/data/sessions/session-records')
  await upsertOwnSessionRecord({ sessionId: 'execution-child', provider: 'codex', projectPath: directory, lastActivityAt: 1, parentSessionId: 'lead' })
  const id = 'execution-child'
  const published: Array<{ revision: number; stored: Promise<number | undefined> }> = []
  const recorder = new SessionExecutionRecorder((sessionId, toolId, execution) => {
    published.push({
      revision: execution.revision,
      stored: readSessionExecution('local', sessionId, toolId).then((row) => row?.revision),
    })
  })
  recorder.status({ sessionId: id, agentSessionId: null, status: 'connecting', at: 1 }, 'first')
  recorder.status({ sessionId: id, agentSessionId: 'provider-thread', status: 'awaiting_input', at: 2, awaitingApproval: true }, 'first')
  await recorder.settled()
  expect(await readSessionExecution('local', id, '')).toMatchObject({
    current: { runId: 'first', phase: 'awaiting_input', startedAt: 1 }, awaitingApproval: true,
  })
  expect(await readSessionExecution('another-organization', id, '')).toBeNull()

  recorder.status({ sessionId: id, agentSessionId: 'provider-thread', status: 'completed', at: 3 }, 'first')
  recorder.settle(id, 'first', 'completed', 3)
  recorder.settle(id, 'first', 'failed', 3)
  await recorder.settled()
  const tree = await readSessionTree('local', 'lead')
  expect(tree.nodes.find((node) => node.record.sessionId === id)).toMatchObject({
    digest: null, record: { execution: { current: null, lastTurn: { runId: 'first', outcome: 'completed', startedAt: 1, endedAt: 3 } } },
  })
  expect(await Promise.all(published.map(async ({ revision, stored }) => (await stored) === revision))).toEqual([true, true, true, true])

  recorder.status({ sessionId: id, agentSessionId: 'provider-thread', status: 'running', at: 4 }, 'next')
  await recorder.settled()
  expect(await readSessionExecution('local', id, '')).toMatchObject({
    current: { runId: 'next', phase: 'running', startedAt: 4 }, lastTurn: { runId: 'first', outcome: 'completed' },
  })
  recorder.status({ sessionId: id, agentSessionId: 'provider-thread', status: 'rate_limited', at: 4 }, 'next', { rateLimitResetsAt: 10_000 })
  await recorder.settled()
  expect((await readSessionTree('local', id)).nodes[0]?.record.execution?.current)
    .toMatchObject({ phase: 'rate_limited', rateLimitResetsAt: 10_000 })
  recorder.status({ sessionId: id, agentSessionId: 'provider-thread', status: 'background', at: 4 }, 'next', { waitingForAgents: true })
  await recorder.settled()
  const background = (await readSessionTree('local', id)).nodes[0]?.record.execution?.current
  expect(background).toMatchObject({ phase: 'background', waitingForAgents: true })
  expect(background?.rateLimitResetsAt).toBeUndefined()
  await interruptOwnSessionExecutions(5)
  expect(await readSessionExecution('local', id, '')).toMatchObject({
    current: null, lastTurn: { runId: 'next', outcome: 'interrupted', startedAt: 4, endedAt: 5 },
  })
})

test('a copied child never loses a newer status to an older host response or local restart', async () => {
  const { readSessionTree, storeRemoteSessionTree } = await import('@solus/server/data/sessions/session-digests')
  const { interruptOwnSessionExecutions } = await import('@solus/server/data/sessions/session-executions')
  const rec = { sessionId: 'execution-copy', parentSessionId: 'lead', provider: 'claude-code' as const, projectPath: '/remote', lastActivityAt: 1, runnerHostId: 'remote' }
  const newer: import('@solus/contracts/session-execution').SessionExecution = {
    revision: 3, current: { runId: 'run', phase: 'background', startedAt: 1 }, lastTurn: null,
  }
  const digest = digestOf(rec.sessionId, 'Remote work')
  digest.subagents[0]!.id = 'tool'
  await storeRemoteSessionTree('lead', [{ record: { ...rec, execution: newer }, digest, artifacts: [],
    subagentExecutions: [{ toolId: 'tool', execution: newer }],
  }])
  await storeRemoteSessionTree('lead', [{ record: { ...rec, execution: { ...newer, revision: 2 } }, digest, artifacts: [] }])
  await interruptOwnSessionExecutions(5)
  expect((await readSessionTree('local', 'lead')).nodes.find((node) => node.record.sessionId === rec.sessionId)).toMatchObject({
    record: { execution: newer },
    subagentExecutions: [{ toolId: 'tool', execution: newer }],
  })
})

test('a provider subagent status is saved from its lifecycle and read with its metadata', async () => {
  const { SessionDigests } = await import('@solus/server/execution/sessions/session-digests')
  const { SessionExecutionRecorder } = await import('@solus/server/execution/sessions/session-execution-recorder')
  const { readSessionTree, writeSessionDigest } = await import('@solus/server/data/sessions/session-digests')
  const { upsertOwnSessionRecord } = await import('@solus/server/data/sessions/session-records')
  const id = 'execution-provider-subagent'
  await upsertOwnSessionRecord({ sessionId: id, provider: 'claude-code', projectPath: directory, lastActivityAt: 1 })
  const recorder = new SessionExecutionRecorder(() => {})
  const digests = new SessionDigests({
    load: async () => null,
    write: writeSessionDigest,
    announce: () => {},
    subagentChanged: (sessionId, subagent) => recorder.subagent(sessionId, subagent),
  })
  digests.observe(id, { type: 'tool_call', toolId: 'tool', toolName: 'Agent', toolInput: '{"description":"Audit"}' })
  await digests.settled()
  await recorder.settled()
  expect((await readSessionTree('local', id)).nodes[0]?.subagentExecutions).toMatchObject([
    { toolId: 'tool', execution: { current: { phase: 'running' }, lastTurn: null } },
  ])
  digests.observe(id, { type: 'subagent_report', toolUseId: 'tool', text: 'Audit done', isError: false })
  await digests.settled()
  await recorder.settled()
  expect((await readSessionTree('local', id)).nodes[0]?.subagentExecutions).toMatchObject([
    { toolId: 'tool', execution: { current: null, lastTurn: { outcome: 'completed' } } },
  ])
})
