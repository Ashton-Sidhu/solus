import { sql } from 'drizzle-orm'
import {
  hostWebhookSettingsPatchSchema,
  webhookDryRunRequestSchema,
  type HostWebhookSettings,
  type WebhookDryRunResult,
} from '@solus/contracts/webhooks'
import type { SolusServer } from '../server'
import { organizationForNew } from '../../admission/principal'
import { attributionOf, ownerKeyOf } from '../../admission/actor'
import { roleOf, visibleTo } from '../../admission/access'
import { getServerSettings, setWebhookPublicUrl } from '../../host/settings'
import { listDeliveries, loadWebhook, readDelivery } from '../../data/webhooks/webhook-store'
import { readWebhookSecrets, verificationSecretOf } from '../../data/webhooks/webhook-secrets'
import { requestData } from '../../execution/webhooks/request-data'
import { verifyRequest } from '../../execution/webhooks/verification'
import type { WebhookActionRunner } from '../../execution/webhooks/action-runner'
import type { WebhookService } from '../../execution/webhooks/webhook-service'
import { answerSecretRequest } from '../../execution/sessions/secret-requests'

/** What the host's link says about webhooks (plan §2.3): the hold switch is stored in Solus Cloud. */
export interface WebhookLinkSettings {
  linked(): boolean
  /** Null while the host is not linked. */
  holdWhileOffline(): boolean | null
  setHoldWhileOffline(hold: boolean): Promise<void>
}

export interface WebhookHandlerDeps {
  webhooks: WebhookService
  actions: WebhookActionRunner
  link: WebhookLinkSettings
}

/**
 * RPC surface of webhooks (docs/plans/webhooks.md §5). A call that names a
 * webhook passed the gate with the role it needs; a list holds only what the
 * caller may see. The token goes to the owner only.
 */
export function registerWebhookHandlers(server: SolusServer, deps: WebhookHandlerDeps): void {
  const { webhooks, actions, link } = deps

  function hostSettings(): HostWebhookSettings {
    return { publicUrl: getServerSettings().webhookPublicUrl ?? null, holdWhileOffline: link.holdWhileOffline(), linked: link.linked() }
  }

  server.register('webhookList', async (_args, ctx) =>
    webhooks.list(visibleTo(ctx.actor, 'webhook', { id: sql`id`, organization: sql`organization_id`, owner: sql`owner_key` })))

  server.register('webhookRead', async ([id], ctx) => {
    const webhook = await webhooks.read(id)
    if (!webhook) return null
    return ownerKeyOf(ctx.actor) === webhook.ownerKey ? webhooks.readWithUrl(id) : webhook
  })

  server.register('webhookCreate', async ([input], ctx) =>
    webhooks.create(input, attributionOf(ctx.actor), organizationForNew(ctx.principal)))

  server.register('webhookUpdate', async ([id, patch]) => webhooks.update(id, patch))

  server.register('webhookDelete', async ([id]) => webhooks.delete(id))

  server.register('webhookRotate', async ([id]) => webhooks.rotate(id))

  server.register('webhookListDeliveries', async ([id, query]) => listDeliveries(id, query ?? {}))

  server.register('webhookReadDelivery', async ([id, deliveryId]) => {
    const delivery = await readDelivery(deliveryId)
    return delivery?.webhookId === id ? delivery : null
  })

  server.register('webhookReplay', async ([id, deliveryId, actionId]) => {
    const webhook = await loadWebhook(id)
    if (!webhook) throw new Error('That webhook does not exist.')
    return actions.replay(webhook, deliveryId, actionId)
  })

  server.register('webhookDryRun', async ([rawRequest], ctx): Promise<WebhookDryRunResult> => {
    const request = webhookDryRunRequestSchema.parse(rawRequest)
    const { sample } = request
    const data = requestData(sample.method, sample.headers, sample.query, Buffer.from(sample.body, 'utf8'))
    let verification: WebhookDryRunResult['verification'] = null
    if (request.webhookId && sample.verify) {
      const webhook = await loadWebhook(request.webhookId)
      // Only a person who may edit the webhook tests a request against its secret.
      const role = webhook ? roleOf(ctx.actor, { kind: 'webhook', id: webhook.id, ownerKey: webhook.ownerKey, organizationId: webhook.organizationId, acl: [] }) : 'none'
      if (!webhook || (role !== 'owner' && role !== 'editor')) throw new Error('That webhook does not exist.')
      verification = await verifyRequest(webhook.verification, data, { secret: verificationSecretOf(readWebhookSecrets(webhook.id)), now: Date.now() })
    }
    return { verification, actions: actions.dryRun(request.actions, data) }
  })

  // The answer of a `secret` card (plan §3.6). It never passes through respondQuestion.
  server.register('secretRequestAnswer', async ([sessionId, questionId, values]) => answerSecretRequest(sessionId, questionId, values))

  server.register('hostWebhookSettingsRead', async () => hostSettings())

  server.register('hostWebhookSettingsUpdate', async ([rawPatch]) => {
    const patch = hostWebhookSettingsPatchSchema.parse(rawPatch)
    if (patch.publicUrl !== undefined) setWebhookPublicUrl(patch.publicUrl)
    if (patch.holdWhileOffline !== undefined) {
      if (!link.linked()) throw new Error('Link this host to Solus Cloud to hold webhooks while it is offline.')
      await link.setHoldWhileOffline(patch.holdWhileOffline)
    }
    return hostSettings()
  })
}
