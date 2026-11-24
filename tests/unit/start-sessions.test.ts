import { actAsHostForTests } from '@solus/server/execution/seats/acting-identity'
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import type { AgentId, AgentTarget } from '@solus/contracts/types'
import type { SpawnOrder } from '@solus/server/execution/orchestration/session-orders'
import type { SessionLoadMessage } from '@solus/contracts/session-history'

// WHY: sessions in one call start together, and a bad entry must start none
// of them so the caller can correct the request and retry the whole group. Each
// child keeps the rules a single child had — the provider and model it may
// run on, the permission ceiling, its task, its checkout — and a reload must
// pair each card with its own brief. Each session has its own settings, so
// one call can start a Codex worker and a Claude reviewer side by side.

mock.module('node:sqlite', () => ({ DatabaseSync }))
actAsHostForTests()
const gitHelpers = await import('@solus/server/git/git-helpers')
const worktrees = await import('@solus/server/git/worktree-manager')
mock.module('@solus/server/git/git-helpers', () => ({ ...gitHelpers, resolveRepoRoot: async () => '/fixture/repository' }))
mock.module('@solus/server/git/worktree-manager', () => ({ ...worktrees, getHeadCommit: async () => 'a'.repeat(40) }))
let tools: typeof import('@solus/server/execution/agents/tools/session-tools')
let start: typeof import('@solus/server/execution/agents/tools/start-sessions-tool')['startSessionsAgentTool']
const { recordSessionSettings, resetSessionSettingsForTests } = await import('@solus/server/execution/sessions/session-settings')
let projection: typeof import('@solus/server/data/sessions/result-projection')
let closeDb: () => void
let directory: string
const previous = process.env.SOLUS_DATA_DIR
const starts: Array<{ sender?: string; order: SpawnOrder; report: boolean; wait?: number; key?: string }> = []
/** Spawns that have begun and not yet returned. */
let inFlight = 0
let mostInFlight = 0
const targets: AgentTarget[] = ['claude-code', 'codex'].map((provider) => ({
  provider: provider as AgentId, label: provider, available: true, defaultModel: `${provider}-default`,
  models: ['default', 'chosen'].map(name => ({ id: `${provider}-${name}`, label: name, reasoningLevels: ['medium', 'high'], defaultReasoningEffort: 'medium', defaultContextWindow: 1000 })),
}))
function context(provider: 'claude-code' | 'codex'): AgentToolContext {
  return { provider, cwd: directory, sessionId: () => `parent-${provider}`, emit: () => {}, abortSignal: new AbortController().signal, parentToolUseId: () => undefined }
}
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'solus-start-sessions-'))
  process.env.SOLUS_DATA_DIR = directory
  tools = await import('@solus/server/execution/agents/tools/session-tools')
  start = (await import('@solus/server/execution/agents/tools/start-sessions-tool')).startSessionsAgentTool
  projection = await import('@solus/server/data/sessions/result-projection')
  ;({ closeDb } = await import('@solus/server/db'))
  tools.setSessionController({
    listAgentTargets: async () => targets,
    permissionModeFor: () => 'supervised',
    codebaseIdFor: async (sessionId) => sessionId === 'parent-codex' ? 'codebase-shop' : null,
    getSessionInfo: async sessionId => ({ sessionId, provider: sessionId.endsWith('codex') ? 'codex' : 'claude-code', model: sessionId.endsWith('codex') ? 'codex-chosen' : 'claude-code-chosen', reasoningEffort: 'high', cwd: directory, slug: null, firstMessage: null, lastTimestamp: '', size: 0, projectPath: directory }),
    liveStatus: () => 'running', pendingInputEvents: () => [], loadSessionTail: async () => [],
    loadPlanContent: async () => null, listPlans: async () => [], invalidatePlanCaches: () => {},
  })
  tools.setSessionOrchestration({
    spawn: async (sender, order, report, wait, key) => {
      const item = starts.push({ sender, order, report, wait, key }) - 1
      mostInFlight = Math.max(mostInFlight, ++inFlight)
      await Promise.resolve()
      inFlight -= 1
      if (order.prompt === 'Breaks at spawn') throw new Error('Provider seat is gone')
      return { exchangeId: `exchange-${item}`, sessionId: `child-${item}`, starting: true }
    },
    send: async () => ({ exchangeId: 'exchange-send', disposition: 'started' }), stop: () => true,
  })
})
beforeEach(() => { starts.length = 0; mostInFlight = 0; resetSessionSettingsForTests() })
afterAll(() => { closeDb(); rmSync(directory, { recursive: true, force: true }); if (previous === undefined) delete process.env.SOLUS_DATA_DIR; else process.env.SOLUS_DATA_DIR = previous })

/** The cards a reloading client rebuilds from this call: its row's projected results. */
function reloaded(text: string) {
  const rows: SessionLoadMessage[] = [
    { role: 'tool', toolName: 'mcp__solus__start_sessions', toolId: 't1', content: '', timestamp: 1 },
    { role: 'tool_result', toolResultForId: 't1', content: text, timestamp: 2 },
  ]
  return projection.projectSessionHistory(rows)[1]!.agentConversationResults
}

test('every session in one call starts at the same time, and each result names its own entry', async () => {
  const result = await start.execute({ sessions: [
    { prompt: 'Build the ledger', title: 'Ledger' },
    { prompt: 'Build the ingest', title: 'Ingest' },
    { prompt: 'Build the invoices', title: 'Invoices' },
  ] }, context('codex'))
  expect(result.ok).toBe(true)
  expect(mostInFlight).toBe(3)
  expect(starts.map((started) => started.order.prompt)).toEqual(['Build the ledger', 'Build the ingest', 'Build the invoices'])
  expect(result.text).toContain('Started 3 of 3 sessions')
  expect(reloaded(result.text)).toEqual([0, 1, 2].map((item) => ({ sessionId: `child-${item}`, messageId: `exchange-${item}`, provider: 'codex', item })))
})

test('each session gets the codebase of the session that starts it', async () => {
  // WHY: docs/plans/codebases.md decision 5. A child works on the same piece of
  // work as its sender, so it must get the same folders; a sender with one
  // working directory must not give its children a codebase.
  await start.execute({ sessions: [{ prompt: 'Change the API' }, { prompt: 'Research', independent: true }] }, context('codex'))
  expect(starts.map((started) => started.order.codebaseId)).toEqual(['codebase-shop', 'codebase-shop'])

  starts.length = 0
  await start.execute({ sessions: [{ prompt: 'Change the API' }] }, context('claude-code'))
  expect(starts.map((started) => started.order.codebaseId)).toEqual([null])
})

test('one bad entry starts no session, and names the entry to correct', async () => {
  const result = await start.execute({ sessions: [
    { prompt: 'Fine' },
    { prompt: 'Needs a checkout', worktree_base_branch: 'main' },
  ] }, context('codex'))
  expect(result).toEqual({ ok: false, text: 'sessions[1]: worktree_base_branch requires isolation=worktree. No session was started.' })
  expect(starts).toEqual([])
})

test('a session that fails to start does not take the others with it', async () => {
  const result = await start.execute({ sessions: [{ prompt: 'Works' }, { prompt: 'Breaks at spawn' }] }, context('codex'))
  expect(result.ok).toBe(true)
  expect(result.text).toContain('Started 1 of 2 sessions')
  expect(result.text).toContain('2. Not started: Provider seat is gone')
  expect(reloaded(result.text)).toEqual([{ sessionId: 'child-0', messageId: 'exchange-0', provider: 'codex', item: 0 }])
})

test('retries name each entry, so a repeated call finds every session it started', async () => {
  expect((await start.execute({ sessions: [{ prompt: 'A' }, { prompt: 'B' }], request_id: 'staff-1' }, context('codex'))).ok).toBe(true)
  expect(starts.map((started) => started.key)).toEqual(['staff-1#0', 'staff-1#1'])
})

for (const parent of ['claude-code', 'codex'] as const) {
  const other = parent === 'codex' ? 'claude-code' : 'codex'
  test(`${parent} starts ${other} children through the same durable engine`, async () => {
    const result = await start.execute({ sessions: [{ prompt: 'Review the change', agent_provider: other }], request_id: 'review-1' }, context(parent))
    expect(result.ok).toBe(true)
    expect(result.text).toContain('child-0')
    expect(result.text).toContain('exchange-0')
    expect(starts).toEqual([expect.objectContaining({ sender: `parent-${parent}`, report: true, wait: 0, key: 'review-1#0', order: expect.objectContaining({ provider: other, modelId: `${other}-default`, permissionMode: 'supervised', independent: false }) })])
  })
  test(`${parent} children on the same provider inherit its model and effort`, async () => {
    expect((await start.execute({ sessions: [{ prompt: 'Review' }] }, context(parent))).ok).toBe(true)
    expect(starts[0]?.order).toMatchObject({ provider: parent, modelId: `${parent}-chosen`, reasoningEffort: 'high' })
  })
}

test('the default worker model applies only to children without an explicit provider or model', async () => {
  recordSessionSettings('parent-codex', {
    organizationId: 'local',
    preferences: { workerModel: { provider: 'claude-code', model: 'claude-code-chosen', reasoningEffort: 'high' } },
  })
  const result = await start.execute({ sessions: [
    { prompt: 'Review' },
    { prompt: 'Explore', reasoning_effort: 'medium' },
    { prompt: 'Use Codex', agent_provider: 'codex' },
    { prompt: 'Use the requested model', model_id: 'codex-default' },
    { prompt: 'Open a separate conversation', independent: true },
  ] }, context('codex'))
  expect(result.ok).toBe(true)
  expect(starts.map(({ order }) => [order.provider, order.modelId, order.reasoningEffort])).toEqual([
    ['claude-code', 'claude-code-chosen', 'high'],
    ['claude-code', 'claude-code-chosen', 'medium'],
    ['codex', 'codex-chosen', 'high'],
    ['codex', 'codex-default', 'medium'],
    ['codex', 'codex-chosen', 'high'],
  ])
})

test('a child can narrow permission but cannot increase it', async () => {
  expect((await start.execute({ sessions: [{ prompt: 'Plan', permission_mode: 'plan' }] }, context('codex'))).ok).toBe(true)
  expect(starts[0]?.order.permissionMode).toBe('plan')
  starts.length = 0
  const denied = await start.execute({ sessions: [{ prompt: 'Change files', permission_mode: 'full-access' }] }, context('codex'))
  expect(denied.ok).toBe(false)
  expect(denied.text).toContain('Only the user')
  expect(starts).toEqual([])
})

test('unknown models and unsupported effort start no session', async () => {
  for (const input of [{ model_id: 'missing' }, { reasoning_effort: 'max' }]) {
    expect((await start.execute({ sessions: [{ prompt: 'Review', ...input }] }, context('codex'))).ok).toBe(false)
  }
  expect(starts).toEqual([])
})

test('empty workspace values cannot turn an isolated launch into shared work', async () => {
  for (const input of [
    { worktree_base_branch: '   ' },
    { cwd: '   ' },
    { cwd: '   ', worktree_base_branch: 'main', host: 'Host B' },
  ]) {
    const result = await start.execute({ sessions: [{ prompt: 'Implement', isolation: 'worktree', ...input }] }, context('codex'))
    expect(result.ok).toBe(false)
  }
  expect(starts).toEqual([])
})

test('attachments, waiting, and reports keep their Solus behavior', async () => {
  writeFileSync(join(directory, 'brief.md'), '# Brief')
  expect((await start.execute({ sessions: [{ prompt: 'Review the brief', attachments: ['brief.md'], report: false }], wait_seconds: 30 }, context('codex'))).ok).toBe(true)
  expect(starts[0]).toMatchObject({ wait: 30000, report: false, order: { attachments: [join(directory, 'brief.md')] } })
})

test('isolated sessions bind to the repository and selected commit before startup', async () => {
  const commit = 'a'.repeat(40)
  expect(await start.execute({ sessions: [
    { prompt: 'One', isolation: 'worktree' },
    { prompt: 'Two', worktree_base_branch: 'release', isolation: 'worktree' },
    { prompt: 'Review in place' },
  ] }, context('codex'))).toMatchObject({ ok: true })
  expect(starts.map((started) => [started.order.cwd, started.order.worktreeBaseBranch])).toEqual([['/fixture/repository', commit], ['/fixture/repository', 'release'], [directory, null]])
})

test('a started session joins no task, even when its caller has one', async () => {
  // WHY: a session is not a role of a task. A child filed under its caller's
  // task put work on a task page that nobody chose for it.
  const { linkTaskSession } = await import('@solus/server/data/tasks/task-attachments')
  await linkTaskSession('local', 'github:I_parent', 'parent-codex', 'working')
  expect((await start.execute({ sessions: [{ prompt: 'Implement this part' }, { prompt: 'Separate work', independent: true }] }, context('codex'))).ok).toBe(true)
  expect(starts.map((started) => started.order.taskId)).toEqual([undefined, undefined])
  // The agent does not choose a task either: the field is gone.
  expect((await start.execute({ sessions: [{ prompt: 'Other task', task_id: 'task-7' }] }, context('codex'))).ok).toBe(false)
})

test('independent sessions inherit defaults but have no report, child ownership, or task', async () => {
  const result = await start.execute({ sessions: [{ prompt: 'Independent work', independent: true }] }, context('codex'))
  expect(result.ok).toBe(true)
  expect(result.text).toContain('Independent, codex/codex-chosen')
  expect(starts[0]).toMatchObject({ report: false, order: { independent: true, modelId: 'codex-chosen' } })
})

test('one call mixes providers, models, permission modes, reports, and kinds of session', async () => {
  // WHY: a lead staffs a plan in one call — a Codex implementer in its own
  // checkout, a Claude reviewer that only plans, and a separate conversation —
  // and each must start with exactly the settings its entry names.
  const result = await start.execute({ sessions: [
    { prompt: 'Implement', isolation: 'worktree' },
    { prompt: 'Review', agent_provider: 'claude-code', model_id: 'claude-code-chosen', reasoning_effort: 'medium', permission_mode: 'plan', report: false },
    { prompt: 'Draft the announcement', independent: true },
  ] }, context('codex'))
  expect(result.ok).toBe(true)
  expect(mostInFlight).toBe(3)
  expect(starts.map(({ report, order }) => ({ report, provider: order.provider, modelId: order.modelId, reasoningEffort: order.reasoningEffort, permissionMode: order.permissionMode, independent: order.independent })))
    .toEqual([
      { report: true, provider: 'codex', modelId: 'codex-chosen', reasoningEffort: 'high', permissionMode: 'supervised', independent: false },
      { report: false, provider: 'claude-code', modelId: 'claude-code-chosen', reasoningEffort: 'medium', permissionMode: 'plan', independent: false },
      { report: false, provider: 'codex', modelId: 'codex-chosen', reasoningEffort: 'high', permissionMode: 'supervised', independent: true },
    ])
  expect(reloaded(result.text)?.map((entry) => entry.provider)).toEqual(['codex', 'claude-code', 'codex'])
})

test('settings of the whole call are only the wait and the retry key', async () => {
  const result = await start.execute({ sessions: [{ prompt: 'Review' }], agent_provider: 'claude-code' }, context('codex'))
  expect(result.ok).toBe(false)
  expect(starts).toEqual([])
})

test('the tool is always loaded and states its default and its independent form', () => {
  expect(start.alwaysLoad).toBe(true)
  expect(start.description).toContain('By default each is your child')
  expect(start.description).toContain('independent=true')
})

// WHY: the fallback model keeps delegation going while the default provider
// is out of usage (T3 Code's resolveNewThreadModelSelection). It replaces only
// a default: a provider or model that the caller names never changes. It is
// used only when it can help: on another provider that this host offers and
// that is not out of usage too. The caller must see that a session got it.
describe('the fallback model', () => {
  const reset = Math.ceil(Date.now() / 1000) + 6 * 3600
  const fallbackModel = { provider: 'claude-code' as const, model: 'claude-code-chosen', reasoningEffort: 'high' as const }

  /** Parks a limit on a live codex session of the host login; `codexPercent` is codex's weekly use. */
  async function host(options: { heldOn?: AgentId[]; codexPercent?: number } = {}) {
    const { RateLimitState } = await import('@solus/server/execution/rate-limits')
    const { UsageLimitsStore } = await import('@solus/server/usage/usage-store')
    const held = new RateLimitState()
    const providers = new Map<string, AgentId>()
    for (const provider of options.heldOn ?? ['codex']) {
      held.record(`limited-${provider}`, { type: 'rate_limit', status: 'rejected', resetsAt: reset, rateLimitType: 'seven_day_overage_included' })
      providers.set(`limited-${provider}`, provider)
    }
    const usage = new UsageLimitsStore()
    usage.apply({ provider: 'codex', fiveHour: null, weekly: { usedPercent: options.codexPercent ?? 95, resetsAt: reset * 1000, resetsLabel: null }, planType: null, fetchedAt: Date.now(), stale: false })
    tools.getSessionController()!.providerUsage = { usage, held, providerOf: (id) => providers.get(id), actorOf: () => undefined }
  }

  beforeEach(() => recordSessionSettings('parent-codex', { organizationId: 'local', preferences: { fallbackModel } }))
  afterAll(() => { delete tools.getSessionController()!.providerUsage })

  test('replaces the default of a session with no provider or model while the default provider is out of usage', async () => {
    await host()
    const result = await start.execute({ sessions: [
      { prompt: 'Default' },
      { prompt: 'Independent default', independent: true },
      { prompt: 'Named provider', agent_provider: 'codex' },
      { prompt: 'Named model', model_id: 'codex-default' },
    ] }, context('codex'))
    expect(result.ok).toBe(true)
    expect(starts.map(({ order }) => [order.provider, order.modelId, order.reasoningEffort])).toEqual([
      ['claude-code', 'claude-code-chosen', 'high'],
      ['claude-code', 'claude-code-chosen', 'high'],
      ['codex', 'codex-chosen', 'high'],
      ['codex', 'codex-default', 'medium'],
    ])
    const until = new Date(reset * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
    const lines = result.text.split('\n')
    const note = `Uses the fallback model claude-code/claude-code-chosen: codex is out of usage until ${until}.`
    expect(lines.filter((line) => line.includes(note)).map((line) => line.slice(0, 2))).toEqual(['1.', '2.'])
    expect(result.text.match(/fallback model/g)).toHaveLength(2)
    // The reloaded cards still pair each session with its provider.
    expect(reloaded(result.text)?.map((entry) => entry.provider)).toEqual(['claude-code', 'claude-code', 'codex', 'codex'])
  })

  test('also replaces the default worker model when its provider is out of usage', async () => {
    await host()
    recordSessionSettings('parent-codex', { organizationId: 'local', preferences: { fallbackModel, workerModel: { provider: 'codex', model: 'codex-default', reasoningEffort: undefined } } })
    await start.execute({ sessions: [{ prompt: 'Default' }] }, context('codex'))
    expect(starts[0]?.order).toMatchObject({ provider: 'claude-code', modelId: 'claude-code-chosen' })
  })

  test('a provider at 100% of a window counts as out of usage', async () => {
    await host({ heldOn: [], codexPercent: 100 })
    await start.execute({ sessions: [{ prompt: 'Default' }] }, context('codex'))
    expect(starts[0]?.order.provider).toBe('claude-code')
  })

  test('changes nothing while the default provider has usage', async () => {
    await host({ heldOn: [] })
    const result = await start.execute({ sessions: [{ prompt: 'Default' }] }, context('codex'))
    expect(starts[0]?.order).toMatchObject({ provider: 'codex', modelId: 'codex-chosen' })
    expect(result.text).not.toContain('fallback model')
  })

  test('changes nothing when the fallback provider is out of usage too', async () => {
    await host({ heldOn: ['codex', 'claude-code'] })
    await start.execute({ sessions: [{ prompt: 'Default' }] }, context('codex'))
    expect(starts[0]?.order).toMatchObject({ provider: 'codex', modelId: 'codex-chosen' })
  })

  test('changes nothing when this host does not offer the fallback', async () => {
    await host()
    const claude = targets.find((target) => target.provider === 'claude-code')!
    claude.available = false
    try {
      const result = await start.execute({ sessions: [{ prompt: 'Default' }] }, context('codex'))
      expect(result.ok).toBe(true)
      expect(starts[0]?.order).toMatchObject({ provider: 'codex', modelId: 'codex-chosen' })
    } finally {
      claude.available = true
    }
    starts.length = 0
    recordSessionSettings('parent-codex', { organizationId: 'local', preferences: { fallbackModel: { ...fallbackModel, model: 'claude-code-retired' } } })
    await start.execute({ sessions: [{ prompt: 'Default' }] }, context('codex'))
    expect(starts[0]?.order).toMatchObject({ provider: 'codex', modelId: 'codex-chosen' })
  })

  test('changes nothing with no fallback set', async () => {
    await host()
    recordSessionSettings('parent-codex', { organizationId: 'local', preferences: {} })
    await start.execute({ sessions: [{ prompt: 'Default' }] }, context('codex'))
    expect(starts[0]?.order).toMatchObject({ provider: 'codex', modelId: 'codex-chosen' })
  })
})
