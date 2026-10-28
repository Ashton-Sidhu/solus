import { randomUUID } from 'node:crypto'
import type {
  WebhookAction,
  WebhookActionResult,
  WebhookDeliveryOutcome,
  WebhookDeliverySummary,
} from '@solus/contracts/webhooks'
import { createLogger } from '../../logger'
import type { Actor } from '../../admission/actor'
import { finishDelivery, insertDelivery, readDelivery, type WebhookRecord } from '../../data/webhooks/webhook-store'
import type { AcceptedDelivery } from './receiver'
import { deliveryTag, evaluateFilters, promptPreamble, renderTemplate, requestDataFromStored, type WebhookRequestData } from './request-data'
import { emitWebhookDelivery } from './webhook-events'

const log = createLogger('webhooks', 'action-runner.ts')

/**
 * The actions of one delivery (docs/plans/webhooks.md §3.1, §3.2): each action
 * tests its own filters, renders its own template, and runs in parallel with the
 * others. One failed action does not stop the others. Every action runs as the
 * webhook's owner; the sender is not a person in Solus.
 */

export type SessionState = 'active' | 'archived' | 'missing'

export interface WebhookActionDeps {
  /** The person the webhook runs as. Throws when the owner cannot work unattended (a guest). */
  actorFor(webhook: WebhookRecord): Actor
  /** `start_session`: a new unattended session (`PromptDispatch.startUnattendedSession`). */
  startSession(request: {
    prompt: string
    action: Extract<WebhookAction, { type: 'start_session' }>
    actor: Actor
  }): Promise<{ sessionId: string }>
  /** `send_to_session`: `PromptDispatch.promptSession(…, 'queue', { actor })`. */
  sendToSession(sessionId: string, prompt: string, actor: Actor): Promise<{ disposition: 'started' | 'steered' | 'queued' | 'duplicate' }>
  /** Whether a `send_to_session` target can take a prompt: it exists, and the owner did not archive it. */
  sessionState(sessionId: string, webhook: WebhookRecord): Promise<SessionState>
  /** `run_automation`: `triggerAutomationRun(automation, { context })`; `busy` while a run is active (§3.2). */
  runAutomation(automationId: string, context: string, actor: Actor): Promise<{ status: 'started'; runId: string } | { status: 'busy' }>
  /** An organization admin paused this webhook: Replay refuses it (§3.3). */
  isPausedByAdmin(webhookId: string): boolean
}

/** One action's filter results and prompt, before it runs. */
function planAction(action: WebhookAction, data: WebhookRequestData, tag: string, onlyActionId: string | undefined): WebhookActionResult {
  const { matched, results } = evaluateFilters(data, action.filters)
  const result: WebhookActionResult = { actionId: action.id, type: action.type, status: 'skipped', filters: results, missing: [] }
  if (onlyActionId !== undefined && onlyActionId !== action.id) return { ...result, error: 'Not part of this replay.' }
  if (!action.enabled) return { ...result, error: 'This action is turned off.' }
  if (!matched) return result
  const rendered = renderTemplate(action.template, data, tag)
  return { ...result, status: 'matched', prompt: rendered.text, missing: rendered.missing }
}

/** The text an agent reads: what the tags mean, which webhook sent it, then the rendered template. */
function promptFor(webhook: WebhookRecord, deliveryId: string, tag: string, rendered: string): string {
  return `${promptPreamble(tag)}\nWebhook: ${webhook.name} (delivery ${deliveryId})\n\n${rendered}`
}

export interface DeliveryVerdict {
  outcome: WebhookDeliveryOutcome
  reason: string | null
}

/** The outcome of a delivery from its action results (plan §3.3). */
export function deliveryOutcome(results: WebhookActionResult[]): DeliveryVerdict {
  const ran = results.filter((result) => result.status !== 'skipped')
  if (!ran.length) return { outcome: 'filtered', reason: 'No action matched.' }
  const failed = ran.filter((result) => result.status === 'failed' || result.status === 'busy')
  if (!failed.length) return { outcome: 'ran', reason: null }
  return failed.length === ran.length ? { outcome: 'failed', reason: 'Every matched action failed.' } : { outcome: 'partial', reason: 'Some actions failed.' }
}

export function createWebhookActionRunner(deps: WebhookActionDeps) {
  async function runAction(webhook: WebhookRecord, deliveryId: string, tag: string, action: WebhookAction, planned: WebhookActionResult, actor: Actor): Promise<WebhookActionResult> {
    const prompt = promptFor(webhook, deliveryId, tag, planned.prompt ?? '')
    switch (action.type) {
      case 'start_session': {
        const { sessionId } = await deps.startSession({ prompt, action, actor })
        return { ...planned, status: 'started', sessionId }
      }
      case 'send_to_session': {
        const state = await deps.sessionState(action.sessionId, webhook)
        if (state !== 'active') return { ...planned, status: 'failed', error: state === 'archived' ? 'The target session is archived.' : 'The target session does not exist.' }
        const { disposition } = await deps.sendToSession(action.sessionId, prompt, actor)
        return { ...planned, status: disposition === 'queued' ? 'queued' : 'started', sessionId: action.sessionId }
      }
      case 'run_automation': {
        const run = await deps.runAutomation(action.automationId, prompt, actor)
        if (run.status === 'busy') return { ...planned, status: 'busy', error: 'The automation has a run in progress.' }
        return { ...planned, status: 'started', automationRunId: run.runId }
      }
    }
  }

  /** Runs the actions of a logged delivery and records their results. Never throws. */
  async function runDelivery(delivery: AcceptedDelivery, onlyActionId?: string): Promise<WebhookActionResult[]> {
    const { webhook, deliveryId, data } = delivery
    const tag = deliveryTag()
    const planned = webhook.actions.map((action) => planAction(action, data, tag, onlyActionId))
    let actor: Actor | null = null
    let actorError: string | null = null
    try {
      actor = deps.actorFor(webhook)
    } catch (err) {
      actorError = (err instanceof Error ? err.message : String(err))
    }
    const results = await Promise.all(webhook.actions.map(async (action, index) => {
      const result = planned[index]
      if (result.status !== 'matched') return result
      if (!actor) return { ...result, status: 'failed' as const, error: actorError ?? 'The owner cannot run unattended work.' }
      try {
        const done = await runAction(webhook, deliveryId, tag, action, result, actor)
        log.info('webhook_action_finished', { webhookId: webhook.id, deliveryId, actionId: action.id, status: done.status, sessionId: done.sessionId ?? null })
        return done
      } catch (err) {
        log.warn('webhook_action_failed', { webhookId: webhook.id, deliveryId, actionId: action.id, error: (err instanceof Error ? err.message : String(err)) })
        return { ...result, status: 'failed' as const, error: (err instanceof Error ? err.message : String(err)) }
      }
    }))
    const { outcome, reason } = deliveryOutcome(results)
    try {
      await finishDelivery(deliveryId, outcome, reason, results)
    } catch (err) {
      log.error('webhook_delivery_record_failed', { webhookId: webhook.id, deliveryId, error: (err instanceof Error ? err.message : String(err)) })
    }
    const summary = await readDelivery(deliveryId).catch(() => null)
    if (summary) emitWebhookDelivery(summaryOf(summary))
    log.info('webhook_delivery_finished', { webhookId: webhook.id, deliveryId, outcome })
    return results
  }

  /**
   * Runs a stored delivery again (plan §3.3), for all actions or for one. It skips
   * verification and both duplicate checks, and the log marks it as a replay. A
   * paused webhook refuses it.
   */
  async function replay(webhook: WebhookRecord, deliveryId: string, actionId?: string): Promise<WebhookDeliverySummary> {
    if (!webhook.enabled || deps.isPausedByAdmin(webhook.id)) throw new Error('This webhook is paused. Resume it to replay a delivery.')
    const original = await readDelivery(deliveryId)
    if (!original || original.webhookId !== webhook.id) throw new Error('That delivery is not in the log.')
    if (actionId !== undefined && !webhook.actions.some((action) => action.id === actionId)) throw new Error('That action is not on this webhook.')
    const now = Date.now()
    const id = randomUUID()
    await insertDelivery({
      id,
      webhookId: webhook.id,
      receivedAt: now,
      arrivedAt: now,
      source: original.source,
      outcome: 'pending',
      reason: null,
      replayOf: original.id,
      request: original.request,
      verificationFailure: null,
      actions: [],
    })
    log.info('webhook_delivery_replayed', { webhookId: webhook.id, deliveryId: id, replayOf: original.id })
    await runDelivery({ webhook, deliveryId: id, data: requestDataFromStored(original.request) }, actionId)
    const replayed = await readDelivery(id)
    if (!replayed) throw new Error('The replay was not recorded.')
    return summaryOf(replayed)
  }

  /** A dry run (plan §3.3): filter results and rendered prompts. It starts nothing and stores nothing. */
  function dryRun(actions: WebhookAction[], data: WebhookRequestData): WebhookActionResult[] {
    const tag = deliveryTag()
    return actions.map((action) => planAction(action, data, tag, undefined))
  }

  return { runDelivery, replay, dryRun }
}

export function summaryOf(delivery: WebhookDeliverySummary): WebhookDeliverySummary {
  return {
    id: delivery.id,
    webhookId: delivery.webhookId,
    receivedAt: delivery.receivedAt,
    arrivedAt: delivery.arrivedAt,
    source: delivery.source,
    outcome: delivery.outcome,
    reason: delivery.reason,
    replayOf: delivery.replayOf,
  }
}

export type WebhookActionRunner = ReturnType<typeof createWebhookActionRunner>
