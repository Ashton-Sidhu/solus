import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { IpcContext, SessionCtx, SettingsCtx, StatusBarCtx } from '@solus/contracts/types'
import { cloudModeScenario } from '../../src/cloud-mode'
import { ownedRegisteredHost } from '../../src/cloud-fixtures'
import { hostClient } from '../../src/cloud-sign-in'
import { projectFixture } from '../../src/project-fixture'
import { recordedRuns } from '../../src/oracle'

function promptContext(sessionId: string, cwd: string, threadId: string | null = null, forked = false): IpcContext {
  const session: Partial<SessionCtx> = { sessionId, provider: 'claude-code', agentSessionId: threadId, status: 'idle', workingDirectory: cwd, projectPath: cwd,
    additionalDirs: [], gitContext: null, worktreeBaseBranch: null, contextWindow: null, permissionMode: 'full-access',
    preferredModel: null, reasoningEffort: 'medium', fastMode: false, readOnlyReason: null, organizationId: undefined, forked }
  const settings: Partial<SettingsCtx> = { activeAgent: 'claude-code', executionPreferences: { rateLimitBehavior: 'queue' } }
  const statusBar: Partial<StatusBarCtx> = { model: 'mock-model', reasoningEffort: 'medium', fastMode: false }
  // SAFETY: these are the prompt fields read by the host; the Lab follows the existing cloud prompt fixture.
  return { session, settings, statusBar } as IpcContext
}

// oxlint-disable-next-line eslint/complexity -- One lifecycle owns both hosts, the API reader, and every stage of this proof.
export default cloudModeScenario('portable sessions: two hosts use one cloud history', async ctx => {
  const project = projectFixture()
  ctx.defer('the project fixture is removed', async () => project.stop())
  const a = await ownedRegisteredHost(ctx)
  const b = await ownedRegisteredHost(ctx)
  const cloneA = project.clone('host-a')
  const cloneB = project.clone('host-b')
  const sessionId = randomUUID()
  const api = new Database(join(ctx.stack.solusApi.dataDir, 'solus.db'), { readonly: true })
  const hostA = new Database(join(a.host.dataDir, 'solus.db'), { readonly: true })
  const hostB = new Database(join(b.host.dataDir, 'solus.db'), { readonly: true })
  ctx.defer('the database readers close', async () => { api.close(); hostA.close(); hostB.close() })
  const apiSchema = z.object({ head: z.string().nullable(), synced_turn: z.number(), last_run_host_id: z.string().nullable() })
  const localSchema = z.object({ repository: z.string(), head: z.string().nullable(), turn_count: z.number() })
  const apiRow = (id = sessionId) => apiSchema.nullable().parse(api.query('SELECT head, synced_turn, last_run_host_id FROM session_repositories WHERE session_id = ?').get(id))
  const localRow = (db: Database, id = sessionId) => localSchema.nullable().parse(db.query('SELECT repository, head, turn_count FROM session_storage WHERE session_id = ?').get(id))
  const gitTree = (dataDir: string, repository: string, head: string) => execFileSync('git', ['--git-dir', join(dataDir, 'sessions', 'repositories', `${repository}.git`), 'rev-parse', `${head}^{tree}`], { encoding: 'utf8' }).trim()

  ctx.step('host A changes code and publishes turn 1')
  await a.owner.rpc('watchSession', { sessionId })
  await a.owner.rpc('prompt', promptContext(sessionId, cloneA), { prompt: '__MOCK_WRITE_FILE__ first turn', clientPromptId: `${sessionId}-1` })
  const first = await ctx.until(() => apiRow(), row => !!row?.head && row.synced_turn === 1, 30_000)
  ctx.check('API has the first head and syncedTurn 1', !!first?.head && first.synced_turn === 1, JSON.stringify(first))
  ctx.check('API names host A as lastRunHostId', first?.last_run_host_id === a.hostId, JSON.stringify(first))
  const onA = localRow(hostA)
  ctx.check('host A committed one turn', onA?.turn_count === 1, JSON.stringify(onA))

  ctx.step('host A stops; host B prepares and resumes the same session')
  a.owner.close()
  await a.host.stop()
  const prepared = await b.owner.rpc('sessionPrepare', { sessionId, knownHead: first!.head, sourceHostId: a.hostId })
  ctx.check('host B starts preparation from the cloud', prepared.state === 'started', JSON.stringify(prepared))
  const ready = await ctx.until(() => localRow(hostB), row => row?.head === first?.head, 30_000)
  ctx.check('host B received the first head', ready?.head === first?.head, JSON.stringify(ready))
  ctx.check('turn 1 has the same repository tree on both hosts', !!onA?.head && !!ready?.head && gitTree(a.host.dataDir, onA.repository, onA.head) === gitTree(b.host.dataDir, ready.repository, ready.head))
  const threadA = readFileSync(join(a.host.dataDir, 'lab', 'threads', 'mock-session-001.jsonl'), 'utf8')
  const threadB = readFileSync(join(b.host.dataDir, 'lab', 'threads', 'mock-session-001.jsonl'), 'utf8')
  ctx.check('host B imported the same provider thread file', threadB === threadA)
  await b.owner.rpc('watchSession', { sessionId })
  await b.owner.rpc('prompt', promptContext(sessionId, cloneB, 'mock-session-001'), { prompt: 'second turn', knownHead: first!.head, sourceHostId: a.hostId, clientPromptId: `${sessionId}-2` })
  const second = await ctx.until(() => apiRow(), row => row?.synced_turn === 2, 30_000)
  ctx.check('API still has one session id and two turns', second?.synced_turn === 2, JSON.stringify(second))
  ctx.check('API names host B as lastRunHostId', second?.last_run_host_id === b.hostId, JSON.stringify(second))
  const runsB = recordedRuns({ host: b.host })
  ctx.check('host B resumed the original provider thread', runsB.some(run => run.prompt.includes('second turn') && run.conversation?.kind === 'resume' && run.conversation.threadId === 'mock-session-001'), JSON.stringify(runsB.map(run => run.conversation)))

  ctx.step('host A restarts and gets turn 2 from the cloud before turn 3')
  const restarted = await ctx.restartHost(a.host)
  const ownerA = hostClient(restarted, a.alice, a.hostId, { asOwner: true })
  ctx.defer('alice closes the restarted host A socket', async () => ownerA.close())
  ctx.check('alice reconnects to host A', (await ownerA.connect()).ok)
  await ownerA.rpc('watchSession', { sessionId })
  await ownerA.rpc('prompt', promptContext(sessionId, cloneA, 'mock-session-001'), { prompt: 'third turn', knownHead: second!.head, sourceHostId: b.hostId, clientPromptId: `${sessionId}-3` })
  const third = await ctx.until(() => apiRow(), row => row?.synced_turn === 3, 30_000)
  ctx.check('API has three turns after A syncs and runs', third?.synced_turn === 3 && third.last_run_host_id === a.hostId, JSON.stringify(third))

  ctx.step('host B forks from the newest turn on host A')
  const forkId = randomUUID()
  await b.owner.rpc('watchSession', { sessionId: forkId })
  await b.owner.rpc('prompt', promptContext(forkId, cloneB, 'mock-session-001', true), { prompt: 'fork on B', forkSourceSessionId: sessionId,
    knownHead: third!.head, sourceHostId: a.hostId, clientPromptId: `${forkId}-1` })
  const fork = await ctx.until(() => localRow(hostB, forkId), row => !!row?.head, 30_000)
  ctx.check('fork runs under its own session id after source sync', !!fork?.head && forkId !== sessionId, JSON.stringify(fork))

  ctx.step('cloud sync is off; host B gets a new session from host A')
  await ownerA.rpc('configUpdate', { sessionCloudSync: false })
  await b.owner.rpc('configUpdate', { sessionCloudSync: false })
  const directId = randomUUID()
  await ownerA.rpc('watchSession', { sessionId: directId })
  await ownerA.rpc('prompt', promptContext(directId, cloneA), { prompt: 'direct transfer', clientPromptId: `${directId}-1` })
  const directA = await ctx.until(() => localRow(hostA, directId), row => !!row?.head, 15_000)
  ctx.check('host A has a local head with cloud sync off', !!directA?.head)
  ctx.check('API has no head for the direct session', apiRow(directId)?.head == null)
  await b.owner.rpc('watchSession', { sessionId: directId })
  const directPrepare = await b.owner.rpc('sessionPrepare', { sessionId: directId, knownHead: directA!.head, sourceHostId: a.hostId })
  ctx.check('host B starts the direct transfer', directPrepare.state === 'started')
  const directB = await ctx.until(() => localRow(hostB, directId), row => row?.head === directA?.head, 30_000)
  ctx.check('host B got the repository from host A in chunks', directB?.head === directA?.head, JSON.stringify(directB))

  ctx.step('with cloud sync off and host A stopped, host B reports source-offline')
  const offlineId = randomUUID()
  await ownerA.rpc('watchSession', { sessionId: offlineId })
  await ownerA.rpc('prompt', promptContext(offlineId, cloneA), { prompt: 'offline source', clientPromptId: `${offlineId}-1` })
  const offlineA = await ctx.until(() => localRow(hostA, offlineId), row => !!row?.head, 15_000)
  ownerA.close()
  await restarted.stop()
  await b.owner.rpc('watchSession', { sessionId: offlineId })
  await b.owner.rpc('sessionPrepare', { sessionId: offlineId, knownHead: offlineA!.head, sourceHostId: a.hostId })
  const failed = await ctx.until(() => b.owner.received('session.eventReceived').find(event => event.payload.sessionId === offlineId && event.payload.event.type === 'status_card' && event.payload.event.card.status === 'error'), event => !!event, 30_000)
  ctx.check('the client gets typed source-offline', failed?.payload.event.type === 'status_card' && failed.payload.event.card.syncFailureReason === 'source-offline', JSON.stringify(failed?.payload.event))
})
