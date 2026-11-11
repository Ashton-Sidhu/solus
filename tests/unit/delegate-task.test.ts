import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'
import { afterAll, beforeAll, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import type { AgentId, AgentTarget } from '@solus/contracts/types'
import type { SpawnOrder } from '@solus/server/execution/orchestration/session-orders'

mock.module('node:sqlite', () => ({ DatabaseSync }))
actAsHostForTests()
const gitHelpers = await import('@solus/server/git/git-helpers')
const worktrees = await import('@solus/server/git/worktree-manager')
mock.module('@solus/server/git/git-helpers', () => ({ ...gitHelpers, resolveRepoRoot: async () => '/fixture/repository' }))
mock.module('@solus/server/git/worktree-manager', () => ({ ...worktrees, getHeadCommit: async () => 'a'.repeat(40) }))
let tools: typeof import('@solus/server/execution/agents/tools/session-tools')
let delegate: typeof import('@solus/server/execution/agents/tools/delegate-task-tool')['delegateTaskAgentTool']
let closeDb: () => void
let directory: string
const previous = process.env.SOLUS_DATA_DIR
const starts: Array<{ sender?: string; order: SpawnOrder; report: boolean; wait?: number; key?: string }> = []
const targets: AgentTarget[] = ['claude-code', 'codex'].map((provider) => ({
  provider: provider as AgentId, label: provider, available: true, defaultModel: `${provider}-default`,
  models: ['default', 'chosen'].map(name => ({ id: `${provider}-${name}`, label: name, reasoningLevels: ['medium', 'high'], defaultReasoningEffort: 'medium', defaultContextWindow: 1000 })),
}))
function context(provider: 'claude-code' | 'codex'): AgentToolContext {
  return { provider, cwd: directory, sessionId: () => `parent-${provider}`, emit: () => {}, abortSignal: new AbortController().signal, parentToolUseId: () => undefined }
}
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'solus-delegate-'))
  process.env.SOLUS_DATA_DIR = directory
  tools = await import('@solus/server/execution/agents/tools/session-tools')
  delegate = (await import('@solus/server/execution/agents/tools/delegate-task-tool')).delegateTaskAgentTool
  ;({ closeDb } = await import('@solus/server/db'))
  tools.setSessionController({
    listAgentTargets: async () => targets,
    permissionModeFor: () => 'supervised',
    getSessionInfo: async sessionId => ({ sessionId, provider: sessionId.endsWith('codex') ? 'codex' : 'claude-code', model: sessionId.endsWith('codex') ? 'codex-chosen' : 'claude-code-chosen', reasoningEffort: 'high', cwd: directory, slug: null, firstMessage: null, lastTimestamp: '', size: 0, projectPath: directory }),
    liveStatus: () => 'running', pendingInputEvents: () => [], loadSessionTail: async () => [],
    loadPlanContent: async () => null, listPlans: async () => [], invalidatePlanCaches: () => {},
  })
  tools.setSessionOrchestration({
    spawn: async (sender, order, report, wait, key) => {
      starts.push({ sender, order, report, wait, key })
      return { exchangeId: 'exchange-1', sessionId: 'child-1', starting: true }
    },
    send: async () => ({ exchangeId: 'exchange-2', disposition: 'started' }), stop: () => true,
  })
})
beforeEach(() => { starts.length = 0 })
afterAll(() => { closeDb(); rmSync(directory, { recursive: true, force: true }); if (previous === undefined) delete process.env.SOLUS_DATA_DIR; else process.env.SOLUS_DATA_DIR = previous })

for (const parent of ['claude-code', 'codex'] as const) {
  const other = parent === 'codex' ? 'claude-code' : 'codex'
  test(`${parent} delegates to ${other} through the same durable engine`, async () => {
    const result = await delegate.execute({ prompt: 'Review the change', agent_provider: other, request_id: 'review-1', task_id: null }, context(parent))
    expect(result.ok).toBe(true)
    expect(result.text).toContain('child-1')
    expect(result.text).toContain('exchange-1')
    expect(starts).toEqual([expect.objectContaining({ sender: `parent-${parent}`, report: true, wait: 0, key: 'review-1', order: expect.objectContaining({ provider: other, modelId: `${other}-default`, permissionMode: 'supervised', independent: false, taskId: null }) })])
  })
  test(`${parent} inherits its model and effort for a same-provider child`, async () => {
    expect((await delegate.execute({ prompt: 'Review', task_id: null }, context(parent))).ok).toBe(true)
    expect(starts[0]?.order).toMatchObject({ provider: parent, modelId: `${parent}-chosen`, reasoningEffort: 'high' })
  })
}

test('a child can narrow permission but cannot increase it', async () => {
  expect((await delegate.execute({ prompt: 'Plan', permission_mode: 'plan', task_id: null }, context('codex'))).ok).toBe(true)
  expect(starts[0]?.order.permissionMode).toBe('plan')
  starts.length = 0
  const denied = await delegate.execute({ prompt: 'Change files', permission_mode: 'full-access', task_id: null }, context('codex'))
  expect(denied.ok).toBe(false)
  expect(denied.text).toContain('Only the user')
  expect(starts).toEqual([])
})

test('unknown models, unsupported effort, and contradictory workspaces start no child', async () => {
  for (const input of [{ model_id: 'missing' }, { reasoning_effort: 'max' }, { isolation: 'shared', worktree_base_branch: 'main' }]) {
    expect((await delegate.execute({ prompt: 'Review', task_id: null, ...input }, context('codex'))).ok).toBe(false)
  }
  expect(starts).toEqual([])
})

test('empty workspace values cannot turn an isolated launch into shared work', async () => {
  for (const input of [
    { worktree_base_branch: '   ' },
    { cwd: '   ' },
    { host: 'Host B', cwd: '   ', worktree_base_branch: 'main' },
  ]) {
    const result = await delegate.execute({ prompt: 'Implement', isolation: 'worktree', task_id: null, ...input }, context('codex'))
    expect(result.ok).toBe(false)
  }
  expect(starts).toEqual([])
})

test('attachments, waiting, and reports retain their Solus behavior', async () => {
  writeFileSync(join(directory, 'brief.md'), '# Brief')
  expect((await delegate.execute({ prompt: 'Review the brief', attachments: ['brief.md'], wait_seconds: 30, report: false, task_id: null }, context('codex'))).ok).toBe(true)
  expect(starts[0]).toMatchObject({ wait: 30000, report: false, order: { attachments: [join(directory, 'brief.md')] } })
})

test('isolated children bind to the repository and selected commit before startup', async () => {
  const commit = 'a'.repeat(40)
  expect(await delegate.execute({ prompt: 'Implement independently', isolation: 'worktree', task_id: null }, context('codex'))).toMatchObject({ ok: true })
  expect(starts[0]?.order).toMatchObject({ worktreeBaseBranch: commit })
  expect(starts[0]?.order.cwd).toBe('/fixture/repository')
})

test('local children inherit existing task membership, and null opts out', async () => {
  // A session link needs no copy of the task: the task key is what the child inherits.
  const { linkTaskSession } = await import('@solus/server/data/tasks/task-attachments')
  const task = { id: 'github:I_parent' }
  await linkTaskSession('local', task.id, 'parent-codex', 'working')
  expect((await delegate.execute({ prompt: 'Implement this part' }, context('codex'))).ok).toBe(true)
  expect(starts[0]?.order.taskId).toBe(task.id)
  expect((await delegate.execute({ prompt: 'Separate work', task_id: null }, context('codex'))).ok).toBe(true)
  expect(starts[1]?.order.taskId).toBeNull()
})

test('independent starts inherit defaults but have no report or child ownership', async () => {
  const result = await tools.startSessionAgentTool.execute({ prompt: 'Independent work' }, context('codex'))
  expect(result.ok).toBe(true)
  expect(starts[0]).toMatchObject({ report: false, order: { independent: true, modelId: 'codex-chosen', taskId: null } })
})
