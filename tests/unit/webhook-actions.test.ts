import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebhookAction } from '@solus/contracts/webhooks'
import type { AutomationAction } from '@solus/contracts/types'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/webhooks.md §3.1–§3.3: one delivery fans out to its actions in
// parallel. Each action answers only to its own filters, one failure does not
// stop the others, a busy automation is not queued, and an archived target fails
// only its own action. The log keeps one result row for each action, so "why did
// this not run?" has an answer.

let dataDir: string
let store: typeof import('@solus/server/data/webhooks/webhook-store')
let runnerModule: typeof import('@solus/server/execution/webhooks/action-runner')
let requestDataModule: typeof import('@solus/server/execution/webhooks/request-data')
let actorModule: typeof import('@solus/server/admission/actor')
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-webhook-actions-'))
  process.env.SOLUS_DATA_DIR = dataDir
  store = await import('@solus/server/data/webhooks/webhook-store')
  runnerModule = await import('@solus/server/execution/webhooks/action-runner')
  requestDataModule = await import('@solus/server/execution/webhooks/request-data')
  actorModule = await import('@solus/server/admission/actor')
})

afterEach(async () => {
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

const pullRequest: WebhookAction[] = [
  { id: 'review', type: 'start_session', enabled: true, agentProvider: 'claude-code', modelId: null, reasoningEffort: 'medium', cwd: '/repo', useWorktree: true,
    filters: [{ path: 'headers.x-github-event', op: 'equals', value: 'pull_request' }, { path: 'body.action', op: 'in', values: ['opened', 'reopened'] }],
    template: 'Review {{body.pull_request.html_url}}' },
  { id: 'notes', type: 'send_to_session', enabled: true, sessionId: 'release',
    filters: [{ path: 'headers.x-github-event', op: 'equals', value: 'pull_request' }],
    template: 'New pull request #{{body.number}}' },
  { id: 'ci', type: 'run_automation', enabled: true, automationId: 'fix-ci',
    filters: [{ path: 'headers.x-github-event', op: 'equals', value: 'workflow_run' }],
    template: 'Failed: {{body.workflow_run.html_url}}' },
]

async function webhookWith(actions: WebhookAction[], overrides: Partial<import('@solus/server/data/webhooks/webhook-store').WebhookRecord> = {}) {
  const record = {
    id: `wh-${Math.random().toString(36).slice(2)}`, organizationId: 'local', ownerKey: 'user:owner', name: 'Repo', enabled: true, project: null,
    verification: { scheme: 'none' as const, reason: 'Test sender accepts only a URL.' }, replayKey: null, actions,
    createdBy: { kind: 'system' as const }, copiedUrlHash: null, lostCount: 0, lostAt: null, createdAt: 1, updatedAt: 1, ...overrides,
  }
  await store.insertWebhook(record)
  return record
}

async function logged(webhookId: string, headers: [string, string][], body: object) {
  const data = requestDataModule.requestData('POST', headers, [], Buffer.from(JSON.stringify(body)))
  const deliveryId = crypto.randomUUID()
  await store.insertDelivery({ id: deliveryId, webhookId, receivedAt: 1, arrivedAt: Date.now(), source: 'direct', outcome: 'pending', reason: null, replayOf: null,
    request: requestDataModule.storedRequest(data), verificationFailure: null, actions: [] })
  return { deliveryId, data }
}

function fakeDeps(overrides: Partial<import('@solus/server/execution/webhooks/action-runner').WebhookActionDeps> = {}) {
  const calls: string[] = []
  const prompts: string[] = []
  const deps: import('@solus/server/execution/webhooks/action-runner').WebhookActionDeps = {
    actorFor: () => actorModule.HOST_ACTOR,
    isPausedByAdmin: () => false,
    startSession: async ({ prompt, action }) => { calls.push(`start:${action.id}`); prompts.push(prompt); return { sessionId: 'new-session' } },
    sendToSession: async (sessionId, prompt) => { calls.push(`send:${sessionId}`); prompts.push(prompt); return { disposition: 'queued' } },
    sessionState: async () => 'active',
    runAutomation: async (automationId, context) => { calls.push(`run:${automationId}`); prompts.push(context); return { status: 'started', runId: 'run-1' } },
    ...overrides,
  }
  return { deps, calls, prompts }
}

const opened: [string, string][] = [['x-github-event', 'pull_request']]
const openedBody = { action: 'opened', number: 7, pull_request: { html_url: 'https://github.com/o/r/pull/7' } }

describe('webhook actions', () => {
  test('a pull request runs the two matching actions in parallel and skips the third with its failed filter', async () => {
    const webhook = await webhookWith(pullRequest)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { deps, calls, prompts } = fakeDeps({
      // The first action waits until the second has started: they must run at the same time.
      startSession: async () => { await gate; calls.push('start:review'); return { sessionId: 'new-session' } },
      sendToSession: async (sessionId, prompt) => { calls.push(`send:${sessionId}`); prompts.push(prompt); release(); return { disposition: 'queued' } },
    })
    const { deliveryId, data } = await logged(webhook.id, opened, openedBody)
    const results = await runnerModule.createWebhookActionRunner(deps).runDelivery({ webhook, deliveryId, data })
    expect(calls).toEqual(['send:release', 'start:review'])
    expect(results.map((result) => [result.actionId, result.status])).toEqual([['review', 'started'], ['notes', 'queued'], ['ci', 'skipped']])
    expect(results[2].filters).toEqual([{ filter: pullRequest[2].filters[0], matched: false }])
    // The prompt tells the agent which text is request data.
    expect(prompts[0]).toContain('comes from an outside webhook request')
    expect(prompts[0]).toMatch(/New pull request #<webhook-data-[0-9a-f]+>7<\/webhook-data-[0-9a-f]+>/)
    const stored = await store.readDelivery(deliveryId)
    expect(stored?.outcome).toBe('ran')
    expect(stored?.actions.find((action) => action.actionId === 'review')?.sessionId).toBe('new-session')
  })

  test('one failed action does not stop the others: the delivery is partial', async () => {
    const webhook = await webhookWith(pullRequest)
    const { deps } = fakeDeps({ startSession: async () => { throw new Error('No seat for claude-code.') } })
    const { deliveryId, data } = await logged(webhook.id, opened, openedBody)
    const results = await runnerModule.createWebhookActionRunner(deps).runDelivery({ webhook, deliveryId, data })
    expect(results[0]).toMatchObject({ status: 'failed', error: 'No seat for claude-code.' })
    expect(results[1].status).toBe('queued')
    expect((await store.readDelivery(deliveryId))?.outcome).toBe('partial')
  })

  test('a busy automation is busy, not queued; the delivery failed', async () => {
    const webhook = await webhookWith(pullRequest)
    const { deps, calls } = fakeDeps({ runAutomation: async () => ({ status: 'busy' }) })
    const { deliveryId, data } = await logged(webhook.id, [['x-github-event', 'workflow_run']], { workflow_run: { html_url: 'u' } })
    const results = await runnerModule.createWebhookActionRunner(deps).runDelivery({ webhook, deliveryId, data })
    expect(results.map((result) => result.status)).toEqual(['skipped', 'skipped', 'busy'])
    expect(calls).toEqual([])
    expect((await store.readDelivery(deliveryId))?.outcome).toBe('failed')
  })

  test('an archived target fails only that action, and the webhook stays enabled', async () => {
    const webhook = await webhookWith(pullRequest)
    const { deps } = fakeDeps({ sessionState: async () => 'archived' })
    const { deliveryId, data } = await logged(webhook.id, opened, openedBody)
    const results = await runnerModule.createWebhookActionRunner(deps).runDelivery({ webhook, deliveryId, data })
    expect(results[1]).toMatchObject({ status: 'failed', error: 'The target session is archived.' })
    expect(results[0].status).toBe('started')
    expect((await store.loadWebhook(webhook.id))?.enabled).toBe(true)
  })

  test('an owner who lost access fails every matched action and starts nothing', async () => {
    const webhook = await webhookWith(pullRequest)
    const { deps, calls } = fakeDeps({ actorFor: () => { throw new Error('A guest’s webhook does not run unattended work.') } })
    const { deliveryId, data } = await logged(webhook.id, opened, openedBody)
    const results = await runnerModule.createWebhookActionRunner(deps).runDelivery({ webhook, deliveryId, data })
    expect(results.map((result) => result.status)).toEqual(['failed', 'failed', 'skipped'])
    expect(calls).toEqual([])
    expect((await store.readDelivery(deliveryId))?.outcome).toBe('failed')
  })

  test('no matching action logs the delivery as filtered; a turned-off action is skipped', async () => {
    const webhook = await webhookWith([{ ...pullRequest[1], enabled: false }])
    const { deps } = fakeDeps()
    const { deliveryId, data } = await logged(webhook.id, opened, openedBody)
    const [result] = await runnerModule.createWebhookActionRunner(deps).runDelivery({ webhook, deliveryId, data })
    expect(result).toMatchObject({ status: 'skipped', error: 'This action is turned off.' })
    expect((await store.readDelivery(deliveryId))?.outcome).toBe('filtered')
  })

  test('a replay runs a stored delivery again, for one action, marked as a replay; a paused webhook refuses it', async () => {
    const webhook = await webhookWith(pullRequest)
    const { deps, calls } = fakeDeps()
    const runner = runnerModule.createWebhookActionRunner(deps)
    const { deliveryId } = await logged(webhook.id, opened, openedBody)
    const replayed = await runner.replay(webhook, deliveryId, 'notes')
    expect(replayed.replayOf).toBe(deliveryId)
    expect(replayed.outcome).toBe('ran')
    expect(calls).toEqual(['send:release'])
    const paused = { ...webhook, enabled: false }
    await expect(runner.replay(paused, deliveryId)).rejects.toThrow('paused')
    const adminPaused = runnerModule.createWebhookActionRunner(fakeDeps({ isPausedByAdmin: () => true }).deps)
    await expect(adminPaused.replay(webhook, deliveryId)).rejects.toThrow('paused')
  })

  test('a dry run shows each filter result and prompt, and stores nothing', async () => {
    const webhook = await webhookWith(pullRequest)
    const { deps, calls } = fakeDeps()
    const data = requestDataModule.requestData('POST', opened, [], Buffer.from(JSON.stringify(openedBody)))
    const results = runnerModule.createWebhookActionRunner(deps).dryRun(webhook.actions, data)
    expect(results.map((result) => result.status)).toEqual(['matched', 'matched', 'skipped'])
    expect(results[0].prompt).toContain('https://github.com/o/r/pull/7')
    expect(calls).toEqual([])
    expect(await store.listDeliveries(webhook.id)).toEqual([])
  })
})

describe('run_automation context (plan §3.1, question 3)', () => {
  test("the webhook's rendered template goes into the run prompt after the automation's own prompt", async () => {
    const automations = await import('@solus/server/data/automations/automations-store')
    const runner = await import('@solus/server/execution/automations/automation-runner')
    const action: AutomationAction = { prompt: 'Fix main CI', agentProvider: 'codex', modelId: null, reasoningEffort: 'medium', cwd: '/tmp' }
    const automation = await automations.createAutomation('Fix CI', action, actorModule.attributionOf(actorModule.HOST_ACTOR))
    let prompt = ''
    runner.setAutomationBackgroundSessionDispatcher(async (options) => {
      prompt = options.prompt
      return { sessionId: 'run-session', done: Promise.resolve({ output: 'ok' }) }
    })
    await runner.triggerAutomationRun(automation, { context: 'Failed run: https://ci/1' })
    for (let i = 0; i < 50 && runner.hasActiveRun(automation.id); i++) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(prompt.indexOf('Fix main CI')).toBeLessThan(prompt.indexOf('[Webhook context]\nFailed run: https://ci/1'))
    await runner.triggerAutomationRun(automation)
    for (let i = 0; i < 50 && runner.hasActiveRun(automation.id); i++) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(prompt).not.toContain('[Webhook context]')
  })
})
