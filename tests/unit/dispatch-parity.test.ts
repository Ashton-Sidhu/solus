import { installTestWorkspaceTools } from './helpers/workspace-tools'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskSnapshot } from '@solus/contracts/task-types'

/** The person every change in this file is made by. */
const BY = { kind: 'user' as const, user: { id: { kind: 'account' as const, accountId: 'user-1' }, displayName: 'Test User' } }
/** An agent's session, as the doer of what it wrote. */
const AGENT = { kind: 'agent' as const, sessionId: 'agent-session' }

mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

let createTask: typeof import('@solus/server/data/tasks/task-store')['createTask']
let TaskModule: typeof import('@solus/server/data/tasks/task')
let outbox: typeof import('@solus/server/sync/outbox/outbox-store')
let foreignTasks: typeof import('@solus/server/data/tasks/foreign-tasks')
let taskApplier: typeof import('@solus/server/data/tasks/task-applier')
let taskTools: typeof import('@solus/server/execution/agents/tools/task-tools')
let workTools: typeof import('@solus/server/execution/agents/tools/work-tools')
let works: typeof import('@solus/server/data/works/works')
let commentTools: typeof import('@solus/server/annotations/comment-tools')
let automationTools: typeof import('@solus/server/execution/agents/tools/automation-tools')
let linkedContent: typeof import('@solus/server/data/tasks/linked-content')
let workApplier: typeof import('@solus/server/data/works/work-applier')
let closeDb: typeof import('@solus/server/db')['closeDb']

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir = ''

beforeEach(async () => { await installTestWorkspaceTools() })

beforeAll(async () => {
  // An earlier file may leave the shared connection open on a folder it removed.
  ;({ closeDb } = await import('@solus/server/db'))
  closeDb()
  dataDir = mkdtempSync(join(tmpdir(), 'solus-dispatch-parity-'))
  process.env.SOLUS_DATA_DIR = dataDir
  ;({ createTask } = await import('@solus/server/data/tasks/task-store'))
  TaskModule = await import('@solus/server/data/tasks/task')
  outbox = await import('@solus/server/sync/outbox/outbox-store')
  foreignTasks = await import('@solus/server/data/tasks/foreign-tasks')
  taskApplier = await import('@solus/server/data/tasks/task-applier')
  taskTools = await import('@solus/server/execution/agents/tools/task-tools')
  workTools = await import('@solus/server/execution/agents/tools/work-tools')
  works = await import('@solus/server/data/works/works')
  commentTools = await import('@solus/server/annotations/comment-tools')
  automationTools = await import('@solus/server/execution/agents/tools/automation-tools')
  linkedContent = await import('@solus/server/data/tasks/linked-content')
  workApplier = await import('@solus/server/data/works/work-applier')
  taskApplier.registerTaskOutboxApplier()
  workApplier.registerWorkOutboxApplier()
})

afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

beforeEach(() => {
  outbox.ackOutboxOps(outbox.listOutboxOps().map((op) => op.id))
})

/** A snapshot the way a dispatching client would ship it — the task exists
 *  only "elsewhere", so nothing here writes a local row for it. */
function shippedSnapshot(taskId: string, overrides: Partial<TaskSnapshot['details']['task']> = {}): TaskSnapshot {
  return {
    details: {
      task: {
        id: taskId,
        providerId: 'local',
        projectKey: '/home/dev/solus',
        title: 'Fix the scroll bug',
        body: 'Restore scrollback after refresh.',
        status: 'in_progress',
        url: null,
        labels: [],
        ...overrides,
      } as TaskSnapshot['details']['task'],
      comments: [],
      links: [],
      events: [],
    },
    sessions: [],
  }
}

/** The two-id reality the real backends present: `sessionId()` reports the
 *  provider's thread id, a DIFFERENT string from the Solus session id the
 *  SessionRuntime keys the foreign snapshot under. Using one string for both
 *  hid a keying bug that broke every foreign lookup in production. */
function toolContext(sessionId: string) {
  return {
    cwd: process.cwd(),
    sessionId: () => sessionId,
    parentToolUseId: () => undefined,
    emit: () => {},
  } as never
}

describe('agent task lifecycle policy', () => {
  /** The policy is the one the session's dispatch carried in its person's
   *  preferences (plans/018 §3.3), not the host's config. */
  async function dispatchedWith(sessionId: string, agentTaskLifecyclePolicy: 'none' | 'moderate' | 'autonomous'): Promise<void> {
    const { recordSessionSettings } = await import('@solus/server/execution/sessions/session-settings')
    recordSessionSettings(sessionId, { organizationId: 'local', preferences: { agentTaskLifecyclePolicy } })
  }

  test('none prevents every agent status change', async () => {
    await dispatchedWith('none-policy', 'none')
    const task = await createTask('local', { title: 'User controlled', projectKey: '/p', body: '' })

    const result = await taskTools.updateTaskStatusAgentTool.execute(
      { task_id: task.id, status: 'in_progress' },
      toolContext('none-policy'),
    )

    expect(result.ok).toBe(false)
    expect(result.text).toContain('user controls')
    expect((await TaskModule.Task.byId('local', task.id)).status).toBe('todo')
  })

  test('moderate permits progress but prevents Done', async () => {
    // No preferences were dispatched for this session, so the built-in moderate policy applies.
    const task = await createTask('local', { title: 'User closes this', projectKey: '/p', body: '' })
    const reviewed = await taskTools.updateTaskStatusAgentTool.execute(
      { task_id: task.id, status: 'in_review' },
      toolContext('moderate-policy'),
    )
    const done = await taskTools.updateTaskStatusAgentTool.execute(
      { task_id: task.id, status: 'done' },
      toolContext('moderate-policy'),
    )

    expect(reviewed.ok).toBe(true)
    expect(done.ok).toBe(false)
    expect(done.text).toContain('Moderate mode')
    expect((await TaskModule.Task.byId('local', task.id)).status).toBe('in_review')
  })

  test('autonomous permits Done', async () => {
    await dispatchedWith('autonomous-policy', 'autonomous')
    const task = await createTask('local', { title: 'Agent controlled', projectKey: '/p', body: '' })

    const result = await taskTools.updateTaskStatusAgentTool.execute(
      { task_id: task.id, status: 'done' },
      toolContext('autonomous-policy'),
    )

    expect(result.ok).toBe(true)
    expect((await TaskModule.Task.byId('local', task.id)).status).toBe('done')
  })
})

describe('the host outbox (ADR-0007)', () => {
  test('record → list → apply → ack is the whole lifecycle, and redelivery is a no-op', async () => {
    // WHY: the op id is the idempotence key end to end. A lost ack means the
    // client redelivers, and the applied-ops guard must make that harmless.
    const task = await createTask('local', { title: 'Owned here', projectKey: '/p', body: '' })
    const op = outbox.recordOutboxOp({
      domain: 'tasks',
      resourceId: task.id,
      name: 'comment',
      payload: { body: 'from the borrowed machine', author: 'agent' },
      sessionId: 'session-1',
    })

    expect(outbox.listOutboxOps().map((listed) => listed.id)).toContain(op.id)

    const first = await outbox.applyOutboxOps([op])
    expect(first.applied).toEqual([op.id])
    const redelivered = await outbox.applyOutboxOps([op])
    expect(redelivered.applied).toEqual([op.id])

    const details = await (await TaskModule.Task.byId('local', task.id)).details()
    const matching = details.comments.filter((comment) => comment.id === op.id)
    expect(matching.length).toBe(1)
    expect(matching[0].body).toBe('from the borrowed machine')

    outbox.ackOutboxOps([op.id])
    expect(outbox.listOutboxOps().find((listed) => listed.id === op.id)).toBeUndefined()
  })

  test('a replayed status op cannot regress a later human change', async () => {
    // WHY: last-write-wins must mean "last recorded", not "last delivered". The
    // guard skips an already-applied op instead of trusting timestamps.
    const task = await createTask('local', { title: 'Status races', projectKey: '/p', body: '' })
    const op = outbox.recordOutboxOp({
      domain: 'tasks',
      resourceId: task.id,
      name: 'set-status',
      payload: { status: 'in_review' },
      sessionId: 'session-1',
    })
    await outbox.applyOutboxOps([op])
    expect((await TaskModule.Task.byId('local', task.id)).status).toBe('in_review')

    // A human moves it afterwards; the same op redelivers (lost ack).
    await (await TaskModule.Task.byId('local', task.id)).update({ status: 'done' }, BY)
    const redelivered = await outbox.applyOutboxOps([op])
    expect(redelivered.applied).toEqual([op.id])
    expect((await TaskModule.Task.byId('local', task.id)).status).toBe('done')
    outbox.ackOutboxOps([op.id])
  })

  test('an op against a deleted task dead-letters instead of redelivering forever', async () => {
    const task = await createTask('local', { title: 'Doomed', projectKey: '/p', body: '' })
    const op = outbox.recordOutboxOp({
      domain: 'tasks',
      resourceId: task.id,
      name: 'comment',
      payload: { body: 'too late', author: 'agent' },
    })
    await (await TaskModule.Task.byId('local', task.id)).delete()

    const result = await outbox.applyOutboxOps([op])
    expect(result.failed.length).toBe(1)
    expect(result.failed[0].permanent).toBe(true)

    outbox.markOutboxOpsFailed(result.failed.map(({ id, error }) => ({ id, error })))
    const listed = outbox.listOutboxOps().find((candidate) => candidate.id === op.id)
    expect(listed?.state).toBe('failed')
    outbox.ackOutboxOps([op.id])
  })
})

describe('task tools on a dispatched session (foreign task)', () => {
  const sessionId = 'dispatched-session'
  const foreignTaskId = '01JFOREIGNTASKXXXXXXXXXXXX'

  beforeEach(() => {
    foreignTasks.setForeignTaskSnapshot(sessionId, shippedSnapshot(foreignTaskId))
  })

  test('read_task answers from the shipped snapshot, not this host’s store', async () => {
    // WHY: the task's row lives on another machine. Before this, the Work
    // contract told the agent to call read_task and the call threw "not found".
    const result = await taskTools.readTaskAgentTool.execute(
      { task_id: foreignTaskId },
      toolContext(sessionId),
    )
    expect(result.ok).toBe(true)
    expect(result.text).toContain('Fix the scroll bug')
    expect(result.text).toContain('Restore scrollback after refresh.')
  })

  test('comment_task records an op and the agent reads its own write back', async () => {
    const commented = await taskTools.commentTaskAgentTool.execute(
      { task_id: foreignTaskId, body: 'blocked on X' },
      toolContext(sessionId),
    )
    expect(commented.ok).toBe(true)

    const pending = outbox.pendingOutboxOpsFor('tasks', foreignTaskId)
    expect(pending.length).toBe(1)
    expect(pending[0].name).toBe('comment')

    const read = await taskTools.readTaskAgentTool.execute(
      { task_id: foreignTaskId },
      toolContext(sessionId),
    )
    expect(read.text).toContain('blocked on X')
  })

  test('update_task_status records an op and later snapshots re-overlay it', async () => {
    const moved = await taskTools.updateTaskStatusAgentTool.execute(
      { task_id: foreignTaskId, status: 'in_review' },
      toolContext(sessionId),
    )
    expect(moved.ok).toBe(true)
    expect(moved.text).toContain('in_review')

    // The next prompt re-ships a snapshot the owner host rendered *before* the
    // op drained; the pending overlay keeps the agent's own move visible.
    foreignTasks.setForeignTaskSnapshot(sessionId, shippedSnapshot(foreignTaskId))
    const read = await taskTools.readTaskAgentTool.execute(
      { task_id: foreignTaskId },
      toolContext(sessionId),
    )
    expect(read.text).toContain('status: in_review')
  })

  test('unsupported foreign writes fail honestly, never with "not found"', async () => {
    // WHY: "Task not found" is a lie about a task that exists on another host,
    // and it teaches the agent to re-create work that is already tracked.
    const linked = await taskTools.linkAgentTool.execute(
      { task_id: foreignTaskId, kind: 'session' },
      toolContext(sessionId),
    )
    expect(linked.ok).toBe(false)
    expect(linked.text).toContain('another host')
  })

  test('a local task is untouched by the foreign branch', async () => {
    const task = await createTask('local', { title: 'Local as ever', projectKey: '/p', body: '' })
    const commented = await taskTools.commentTaskAgentTool.execute(
      { task_id: task.id, body: 'plain local comment' },
      toolContext(sessionId),
    )
    expect(commented.ok).toBe(true)
    expect(outbox.pendingOutboxOpsFor('tasks', task.id).length).toBe(0)
    const details = await (await TaskModule.Task.byId('local', task.id)).details()
    expect(details.comments.some((comment) => comment.body === 'plain local comment')).toBe(true)
  })
})

describe('read_task returns what the task packet no longer carries', () => {
  const sessionId = 'dispatched-session-read'
  const read = async (snapshot: TaskSnapshot) => {
    foreignTasks.setForeignTaskSnapshot(sessionId, snapshot)
    return taskTools.readTaskAgentTool.execute({ task_id: snapshot.details.task.id }, toolContext(sessionId))
  }

  test('names the project the task belongs to', async () => {
    // WHY: the packet printed the project; read_task is now the only place the
    // agent learns it.
    const result = await read(shippedSnapshot('01JREADPROJECTXXXXXXXXXXXX'))
    expect(result.text).toContain('project: /home/dev/solus')
  })

  test('names every linked item and the tool that reads it', async () => {
    // WHY: links rendered nowhere agent-visible, so a dispatched agent had no
    // way to discover the design doc its task pointed at.
    const snapshot = shippedSnapshot('01JREADLINKSXXXXXXXXXXXXXX')
    snapshot.details.links = [{
      taskId: snapshot.details.task.id,
      kind: 'work',
      targetScope: '',
      targetKey: 'work-1',
      title: 'Design doc',
      createdBy: AGENT,
      linkedAt: 0,
    }] as never
    const result = await read(snapshot)
    expect(result.text).toContain('Linked:')
    expect(result.text).toContain('work work-1 — "Design doc" (read_work)')
  })

  test('prints the upstream epic with its description, clipped', async () => {
    // WHY: the epic is context the agent cannot read any other way: it may not
    // be a Solus task at all. A long epic must not crowd out the task itself.
    const result = await read(shippedSnapshot('01JREADEPICXXXXXXXXXXXXXXX', {
      epic: { provider: 'jira', externalId: 'ACME-7', url: 'https://acme.atlassian.net/browse/ACME-7', title: 'Release 2.0', body: `Ship the release.\n${'x'.repeat(5000)}` },
    }))
    const lines = result.text.split('\n')
    const at = lines.indexOf('Epic: jira ACME-7 — "Release 2.0" — https://acme.atlassian.net/browse/ACME-7')
    expect(at).toBeGreaterThan(0)
    expect(lines[at + 1].startsWith('  Ship the release. xxx')).toBe(true)
    expect(lines[at + 1].length).toBeLessThan(2100)
    expect(lines[at + 1].endsWith('…')).toBe(true)
  })

  test('a GitHub parent issue reads as its number', async () => {
    const result = await read(shippedSnapshot('01JREADGHEPICXXXXXXXXXXXXX', {
      epic: { provider: 'github', externalId: '12', url: 'https://github.com/o/r/issues/12', title: 'Roadmap', body: '' },
    }))
    expect(result.text).toContain('Epic: github #12 — "Roadmap" — https://github.com/o/r/issues/12')
  })
})

describe('linked-item tools on a dispatched session', () => {
  const sessionId = 'dispatched-session-with-links'
  const foreignTaskId = '01JFOREIGNWORKTASKXXXXXXXX'
  const shippedWork = {
    kind: 'work' as const,
    key: 'work-on-the-task-host',
    scope: '',
    title: 'Host-backed PR Reading',
    workType: 'doc' as const,
    content: '# Design\n\nLazy checkout rules.',
    updatedAt: '2026-08-10T00:00:00.000Z',
    contentVersion: 3,
  }
  const shippedPlan = {
    kind: 'plan' as const,
    key: 'plan-tool-use-1',
    scope: 'task-host-session',
    title: 'Rollout plan',
    content: '## Plan\n\nShip in two slices.',
  }
  const linkRow = (kind: 'pr' | 'automation', targetKey: string, extra: object = {}) => ({
    taskId: foreignTaskId,
    kind,
    targetScope: '',
    targetKey,
    title: kind === 'pr' ? 'Fix the scroll bug' : 'Nightly triage',
    createdBy: AGENT,
    linkedAt: 0,
    ...extra,
  })

  beforeEach(() => {
    const snapshot = shippedSnapshot(foreignTaskId)
    snapshot.details.links = [
      linkRow('pr', '42', { url: 'https://github.com/acme/solus/pull/42' }),
      linkRow('automation', 'automation-on-task-host', { liveTitle: 'Nightly triage', liveStatus: 'Active' }),
    ] as never
    foreignTasks.setForeignTaskSnapshot(sessionId, { ...snapshot, linked: [shippedWork, shippedPlan] })
  })

  test('read_work serves the shipped copy of a work whose row lives elsewhere', async () => {
    // WHY: the task packet points the agent at its linked design doc, and
    // before this the execution host answered "No work found" for a work that
    // exists — on the task's host.
    const result = await workTools.readWorkAgentTool.execute(
      { work_id: shippedWork.key },
      toolContext(sessionId),
    )
    expect(result.ok).toBe(true)
    expect(result.text).toContain('Lazy checkout rules.')
    expect(result.text).toContain('read-only')
  })

  test('find_works with no query surfaces the shipped works beside local ones', async () => {
    const result = await workTools.findWorksAgentTool.execute({}, toolContext(sessionId))
    expect(result.ok).toBe(true)
    expect(result.text).toContain(shippedWork.key)
    expect(result.text).toContain('Host-backed PR Reading')
  })

  test('update_work on a shipped work records a synced op and reads back', async () => {
    // WHY: the row lives on the task's host — the write must travel as an
    // outbox op, not fail, and the agent must see its own revision pre-drain.
    const result = await workTools.updateWorkAgentTool.execute(
      { work_id: shippedWork.key, content: 'revised remotely', expected_content_version: 3 },
      toolContext(sessionId),
    )
    expect(result.ok).toBe(true)
    expect(result.text).toContain('syncs')
    const pending = outbox.pendingOutboxOpsFor('works', shippedWork.key)
    expect(pending.length).toBe(1)
    // The op carries the version the agent read, for the owner to check.
    expect(pending[0]!.payload).toMatchObject({ expectedContentVersion: 3 })

    const read = await workTools.readWorkAgentTool.execute(
      { work_id: shippedWork.key },
      toolContext(sessionId),
    )
    expect(read.text).toContain('revised remotely')
    expect(read.text).toContain('content_version: 4')
    outbox.ackOutboxOps(pending.map((op) => op.id))
  })

  test('update_work from an older read of a shipped work records nothing', async () => {
    // WHY: the owner would refuse the op anyway; the agent must read again now.
    const result = await workTools.updateWorkAgentTool.execute(
      { work_id: shippedWork.key, content: 'from an old read', expected_content_version: 2 },
      toolContext(sessionId),
    )
    expect(result.ok).toBe(false)
    expect(result.text).toContain('Stale write')
    expect(outbox.pendingOutboxOpsFor('works', shippedWork.key)).toEqual([])
  })

  test('an unknown work id still reads as not found', async () => {
    const result = await workTools.readWorkAgentTool.execute(
      { work_id: 'no-such-work' },
      toolContext(sessionId),
    )
    expect(result.ok).toBe(false)
    expect(result.text).toContain('No work found')
  })

  test('read_plan serves the shipped plan when its session is not on this host', async () => {
    // WHY: the plan's provider files live with the task host's session; the
    // shipped copy is the only readable form on the execution host.
    const result = await commentTools.readPlanAgentTool.execute(
      { session_id: shippedPlan.scope },
      toolContext(sessionId),
    )
    expect(result.ok).toBe(true)
    expect(result.text).toContain('Ship in two slices.')
    expect(result.text).toContain('read-only')
  })

  test('read_automation serves linked facts and writes fail honestly', async () => {
    const ctx = { agentProvider: 'claude-code' as const, cwd: '/p', sessionId }
    const read = await automationTools.executeAutomationTool('read_automation', { automation_id: 'automation-on-task-host' }, { ctx })
    expect(read.ok).toBe(true)
    expect(read.text).toContain('Nightly triage')
    expect(read.text).toContain("task's host")

    const run = await automationTools.executeAutomationTool('run_automation', { automation_id: 'automation-on-task-host' }, { ctx })
    expect(run.ok).toBe(false)
    expect(run.text).toContain("task's host")
  })
})

describe('works from a dispatched session travel through the outbox', () => {
  const sessionId = 'dispatched-session-authoring'

  test('create_work records an op, reads back pre-drain, and lands linked on the owner host', async () => {
    // WHY: before this, a dispatched create_work persisted onto the borrowed
    // machine and vanished from the user's world when that machine did.
    const task = await createTask('local', { title: 'Owns the doc', projectKey: '/p', body: '' })
    foreignTasks.setForeignTaskSnapshot(sessionId, shippedSnapshot(task.id))

    const created = await workTools.createWorkAgentTool.execute(
      { title: 'Remote design', doc_type: 'doc', content: '# Authored elsewhere' },
      toolContext(sessionId),
    )
    expect(created.ok).toBe(true)
    const workId = created.text.match(/id: ([0-9a-f-]+)\)/)?.[1] ?? ''
    expect(workId).not.toBe('')

    // Not persisted on the execution host — the op is the write.
    expect(await works.loadWork('local', workId)).toBeNull()

    // The agent reads its own creation back before the courier delivers…
    const read = await workTools.readWorkAgentTool.execute({ work_id: workId }, toolContext(sessionId))
    expect(read.ok).toBe(true)
    expect(read.text).toContain('# Authored elsewhere')

    // …and a fresh re-ship rendered before the drain keeps it visible.
    foreignTasks.setForeignTaskSnapshot(sessionId, shippedSnapshot(task.id))
    const reread = await workTools.readWorkAgentTool.execute({ work_id: workId }, toolContext(sessionId))
    expect(reread.ok).toBe(true)
    expect(reread.text).toContain('# Authored elsewhere')

    // Delivery: the owner writes the row under the same id and links the task.
    const pending = outbox.pendingOutboxOpsFor('works', workId)
    expect(pending.length).toBe(1)
    const first = await outbox.applyOutboxOps(pending)
    expect(first.applied).toEqual(pending.map((op) => op.id))
    const landed = await works.loadWork('local', workId)
    expect(landed?.content).toBe('# Authored elsewhere')
    const details = await (await TaskModule.Task.byId('local', task.id)).details()
    expect(details.links.some((link) => link.kind === 'work' && link.targetKey === workId)).toBe(true)

    // Redelivery (lost ack) is a no-op.
    const redelivered = await outbox.applyOutboxOps(pending)
    expect(redelivered.applied).toEqual(pending.map((op) => op.id))
    outbox.ackOutboxOps(pending.map((op) => op.id))
  })

  test('diagram creation returns a canonical embed token', async () => {
    foreignTasks.setForeignTaskSnapshot(sessionId, shippedSnapshot('diagram-owner'))
    const created = await workTools.createWorkAgentTool.execute(
      { title: 'Auth Architecture', doc_type: 'diagram', content: '{"nodes":[{"id":"api","label":"API"}],"edges":[]}' },
      toolContext(sessionId),
    )

    expect(created.ok).toBe(true)
    const workId = created.text.match(/id: ([0-9a-f-]+)\)/)?.[1] ?? ''
    expect(workId).not.toBe('')
    expect(created.text).toContain(`[Auth Architecture](work://embed?workId=${workId}&type=diagram)`)
  })

  test('a redelivered update op is answered by its receipt on the owner host', async () => {
    const created = await works.createWork('local', 'Owner doc', 'doc', 'v1', '', undefined, 'claude-code', '/p')
    const op = outbox.recordOutboxOp({
      domain: 'works',
      resourceId: created.id,
      name: 'update',
      payload: { taskId: 'any-task', content: 'v2', expectedContentVersion: 1 },
    })
    const result = await outbox.applyOutboxOps([op])
    expect(result.applied).toEqual([op.id])
    expect((await works.loadWork('local', created.id))?.content).toBe('v2')
    const again = await outbox.applyOutboxOps([op])
    expect(again.applied).toEqual([op.id])
    outbox.ackOutboxOps([op.id])
  })

  test('an update op for a work that no longer exists dead-letters', async () => {
    const op = outbox.recordOutboxOp({
      domain: 'works',
      resourceId: 'work-that-is-gone',
      name: 'update',
      payload: { taskId: 'any-task', content: 'too late', expectedContentVersion: 1 },
    })
    const result = await outbox.applyOutboxOps([op])
    expect(result.failed.length).toBe(1)
    expect(result.failed[0].permanent).toBe(true)
    outbox.ackOutboxOps([op.id])
  })
})

describe('the task host ships linked content with the snapshot', () => {
  test('attachLinkedContent carries the full content of every linked work', async () => {
    // WHY: the execution host cannot read this host's folio store, so the
    // snapshot is the only way a dispatched agent can read the task's docs.
    const created = await works.createWork('local', 'Design doc', 'doc', '# The plan', '', undefined, 'claude-code', '/p')
    const task = await createTask('local', { title: 'Task with a doc', projectKey: '/p', body: '' })
    await (await TaskModule.Task.byId('local', task.id)).link({
      kind: 'work',
      targetScope: '',
      targetKey: created.id,
      title: created.title,
    }, AGENT)
    const snapshot = await linkedContent.attachLinkedContent(await TaskModule.taskSnapshot('local', task.id))
    expect(snapshot.linked?.map((item) => item.key)).toEqual([created.id])
    expect(snapshot.linked?.[0].content).toBe('# The plan')
    expect(snapshot.linked?.[0].workType).toBe('doc')
  })

  test('an unresolvable plan link is skipped, and a PR link ships no content', async () => {
    const task = await createTask('local', { title: 'Task with dead links', projectKey: '/p', body: '' })
    const bound = await TaskModule.Task.byId('local', task.id)
    await bound.link({ kind: 'plan', targetScope: 'gone-session', targetKey: 'plan-x', title: 'Lost plan' }, AGENT)
    await bound.link({ kind: 'pr', targetScope: '/p', targetKey: '7', title: '#7', url: 'https://github.com/acme/app/pull/7' }, AGENT)
    const snapshot = await linkedContent.attachLinkedContent(await TaskModule.taskSnapshot('local', task.id))
    expect(snapshot.linked ?? []).toEqual([])
  })
})
