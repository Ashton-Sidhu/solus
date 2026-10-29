import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NormalizedEvent } from '@solus/contracts/types'
import { resetTestDatabase } from './helpers/test-db'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/webhooks.md §3.6: an agent sets up a webhook for the person. Changes
// need approval; reads do not. A secret never passes through a tool: the person
// types it into a private card and the agent gets a one-use secretRef, valid only
// in its own session, for 15 minutes.

let dataDir: string
let tools: typeof import('@solus/server/execution/agents/tools/webhook-tools')
let secretRequests: typeof import('@solus/server/execution/sessions/secret-requests')
let secretTool: typeof import('@solus/server/execution/agents/tools/secret-request-tool')
let secrets: typeof import('@solus/server/data/webhooks/webhook-secrets')
/** The host's answer to "may this webhook start organization work here?"; a test sets a refusal. */
let refusal: string | null = null
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-webhook-tools-'))
  process.env.SOLUS_DATA_DIR = dataDir
  tools = await import('@solus/server/execution/agents/tools/webhook-tools')
  secretRequests = await import('@solus/server/execution/sessions/secret-requests')
  secretTool = await import('@solus/server/execution/agents/tools/secret-request-tool')
  secrets = await import('@solus/server/data/webhooks/webhook-secrets')
  const { createWebhookService } = await import('@solus/server/execution/webhooks/webhook-service')
  const { createWebhookActionRunner } = await import('@solus/server/execution/webhooks/action-runner')
  const { HOST_ACTOR } = await import('@solus/server/admission/actor')
  tools.setWebhookToolServices({
    webhooks: createWebhookService({
      urls: { cloudHost: () => ({ hostId: 'host-1', origin: 'https://app.example.test' }), cloudReady: () => false, publicUrl: () => null },
      isPausedByAdmin: () => false,
      organizationRefusal: (organizationId, work) => refusal ?? (organizationId !== 'local' && work.unverified ? 'This organization does not allow unverified webhooks. Choose a verification scheme.' : null),
      takeSecretRef: secretRequests.takeSecretRef,
    }),
    actions: createWebhookActionRunner({
      actorFor: () => HOST_ACTOR, isPausedByAdmin: () => false, sessionState: async () => 'active',
      startSession: async () => ({ sessionId: 's' }), sendToSession: async () => ({ disposition: 'queued' }), runAutomation: async () => ({ status: 'busy' }),
    }),
  })
})

afterEach(async () => {
  refusal = null
  await resetTestDatabase()
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(dataDir, `solus.db${suffix}`), { force: true })
})

afterAll(() => {
  tools.setWebhookToolServices(null)
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

function context(sessionId: string, events: NormalizedEvent[], abort = new AbortController()) {
  return { provider: 'claude-code' as const, cwd: '/repo', sessionId: () => sessionId, abortSignal: abort.signal, parentToolUseId: () => undefined, emit: (event: NormalizedEvent) => { events.push(event) } }
}

const hmac = {
  scheme: 'hmac' as const, algorithm: 'sha256' as const, signedText: '{{body}}',
  signature: { source: { kind: 'header' as const, name: 'x-hub-signature-256' }, format: { encoding: 'hex' as const, prefix: 'sha256=' } },
}
const actions = [{ id: 'review', type: 'send_to_session' as const, sessionId: 's1', enabled: true, filters: [{ path: 'headers.x-github-event', op: 'equals' as const, value: 'pull_request' }], template: 'Review {{body.pull_request.html_url}}' }]

describe('webhook agent tools', () => {
  test('changes need approval; reads and request_secret do not', () => {
    expect([tools.createWebhookAgentTool, tools.updateWebhookAgentTool, tools.deleteWebhookAgentTool, tools.rotateWebhookAgentTool].every((tool) => tool.requiresApproval)).toBe(true)
    expect([tools.listWebhooksAgentTool, tools.readWebhookDeliveryAgentTool, tools.dryRunWebhookAgentTool, secretTool.requestSecretAgentTool].some((tool) => tool.requiresApproval)).toBe(false)
  })

  test('request_secret shows a private card; the secretRef creates the webhook and the value never reaches the agent', async () => {
    const events: NormalizedEvent[] = []
    const asking = secretTool.requestSecretAgentTool.execute({ name: 'GitHub secret', reason: 'To check signatures.' }, context('session-a', events))
    await Promise.resolve()
    const card = events.find((event) => event.type === 'question_request')
    expect(card).toMatchObject({ type: 'question_request', kind: 'secret' })
    const questionId = card?.type === 'question_request' ? card.questionId : ''
    expect(secretRequests.answerSecretRequest('session-b', questionId, 'typed-secret')).toBe(false)
    expect(secretRequests.answerSecretRequest('session-a', questionId, 'typed-secret')).toBe(true)
    const answer = await asking
    expect(answer.ok).toBe(true)
    expect(answer.text).not.toContain('typed-secret')
    expect(JSON.stringify(events)).not.toContain('typed-secret')
    expect(events.at(-1)).toEqual({ type: 'permission_resolved', questionId })
    const { secretRef } = JSON.parse(answer.text) as { status: 'saved'; secretRef: string }

    const created = await tools.createWebhookAgentTool.execute({ name: 'GitHub', verification: { ...hmac, secretRef }, actions }, context('session-a', []))
    expect(created.ok).toBe(true)
    expect(created.text).toContain('Ask the user to link this host to Solus Cloud')
    const id = /id: ([^)]+)\)/.exec(created.text)![1]
    expect(Buffer.from(secrets.readWebhookSecrets(id)!.secret!, 'base64').toString()).toBe('typed-secret')
    // The ref worked once.
    const again = await tools.createWebhookAgentTool.execute({ name: 'GitHub 2', verification: { ...hmac, secretRef }, actions }, context('session-a', []))
    expect(again).toMatchObject({ ok: false })
    expect(again.text).toContain('secretRef is not valid')
  })

  test('a declined card and a stopped run give no secret', async () => {
    const events: NormalizedEvent[] = []
    const declined = secretTool.requestSecretAgentTool.execute({ name: 'x', reason: 'y' }, context('session-a', events))
    await Promise.resolve()
    const card = events[0]
    secretRequests.answerSecretRequest('session-a', card.type === 'question_request' ? card.questionId : '', null)
    expect(JSON.parse((await declined).text)).toEqual({ status: 'declined' })
    const abort = new AbortController()
    const stopped = secretTool.requestSecretAgentTool.execute({ name: 'x', reason: 'y' }, context('session-a', [], abort))
    abort.abort()
    expect(JSON.parse((await stopped).text)).toEqual({ status: 'cancelled' })
  })

  test('a secretRef belongs to the session that asked and ends after 15 minutes', async () => {
    const events: NormalizedEvent[] = []
    const asking = secretTool.requestSecretAgentTool.execute({ name: 'x', reason: 'y' }, context('session-a', events))
    await Promise.resolve()
    const card = events[0]
    secretRequests.answerSecretRequest('session-a', card.type === 'question_request' ? card.questionId : '', 'v')
    const ref = (JSON.parse((await asking).text) as { secretRef: string }).secretRef
    expect(secretRequests.takeSecretRef(ref, 'session-b')).toBeNull()
    expect(secretRequests.takeSecretRef(ref, 'session-a', Date.now() + 16 * 60 * 1000)).toBeNull()
  })

  test('dry_run_webhook shows filter results and prompts; list_webhooks never shows the token', async () => {
    const dry = await tools.dryRunWebhookAgentTool.execute({ actions, sample: { headers: [['x-github-event', 'push']], body: '{}' } }, context('session-a', []))
    expect(dry.text).toContain('Action review (send_to_session): skipped')
    expect(dry.text).toContain('FAIL')
    const created = await tools.createWebhookAgentTool.execute({ name: 'Open', verification: { scheme: 'none', reason: 'This sender accepts only a URL, no headers.' }, actions }, context('session-a', []))
    const id = /id: ([^)]+)\)/.exec(created.text)![1]
    const listed = await tools.listWebhooksAgentTool.execute({}, context('session-a', []))
    expect(listed.text).toContain(id)
    expect(listed.text).toContain('UNVERIFIED')
    expect(listed.text).not.toContain(secrets.readWebhookSecrets(id)!.token)
  })

  test('a save the organization policy refuses is a clear tool error, and nothing is created', async () => {
    refusal = 'This organization does not allow its work to start on a personal computer. Set up the webhook on a cloud or self-hosted machine of the organization.'
    const answer = await tools.createWebhookAgentTool.execute({ name: 'Open', verification: { scheme: 'none', reason: 'This sender accepts only a URL, no headers.' }, actions }, context('session-a', []))
    expect(answer).toEqual({ ok: false, text: `create_webhook: ${refusal}` })
    refusal = null
    expect((await tools.listWebhooksAgentTool.execute({}, context('session-a', []))).text).toBe('No webhooks exist on this host yet.')
  })

  test('the flat schema the model reads is still checked by the strict contract: a wrong input changes nothing', async () => {
    // The advertised schema is flat to keep the tool list small (agent-tool-schema-size);
    // the contract still refuses an hmac without its signed text, and an eleventh action.
    const missing = await tools.createWebhookAgentTool.execute({ name: 'Bad', verification: { scheme: 'hmac', algorithm: 'sha256', secretRef: 'x' }, actions }, context('session-a', []))
    expect(missing.ok).toBe(false)
    expect(missing.text).toStartWith('create_webhook: Invalid arguments:')
    const tooMany = await tools.dryRunWebhookAgentTool.execute({ actions: Array.from({ length: 11 }, (_, index) => ({ ...actions[0], id: `a${index}` })), sample: { body: '{}' } }, context('session-a', []))
    expect(tooMany.ok).toBe(false)
    expect((await tools.listWebhooksAgentTool.execute({}, context('session-a', []))).text).toBe('No webhooks exist on this host yet.')
  })
})
