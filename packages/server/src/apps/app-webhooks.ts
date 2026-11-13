import { z } from 'zod'
import type { AppDescriptor, AppWebhookDeclaration, AppWebhookView } from '@solus/contracts/apps'
import { SECRET_SCHEMES, type WebhookCreateInput } from '@solus/contracts/webhooks'
import { randomBytes } from 'node:crypto'
import { loadVersion, saveApp, type AppRecord } from '../data/apps/app-store'
import { readWebhookSecrets, verificationSecretOf } from '../data/webhooks/webhook-secrets'
import type { WebhookRequestData } from '../execution/webhooks/request-data'
import type { WebhookService } from '../execution/webhooks/webhook-service'
import { createLogger } from '../logger'
import type { AppAuthority, AppLifecyclePart, Apps } from './apps'

const log = createLogger('apps', 'app-webhooks.ts')

/**
 * The webhooks an app declares (docs/plans/apps.md §8). The webhook owner
 * holds each one as an ordinary webhook record with one action, "call an app
 * mutation": the URL, the verification, the deliveries log, replay, and
 * holding while offline are its own. This part makes a record when a version
 * declares a webhook, changes it when the declaration changes, and deletes it
 * when the declaration or the app goes.
 */

type WebhookRecords = Pick<WebhookService, 'create' | 'update' | 'delete' | 'readWithUrl'>

const ACTION_ID = 'app'

/** A new signing secret, as text a person pastes into the other service. Standard Webhooks has its own form. */
function newSecret(scheme: AppWebhookDeclaration['verify']['scheme']): string {
  return scheme === 'standard_webhooks' ? `whsec_${randomBytes(24).toString('base64')}` : randomBytes(32).toString('base64url')
}

function actionFor(app: AppRecord, declared: AppWebhookDeclaration): WebhookCreateInput['actions'] {
  return [{ id: ACTION_ID, type: 'call_app', enabled: true, filters: [], template: '', appId: app.id, operation: declared.run }]
}

const bodySchema = z.json()

/** A webhook's request as the input of the mutation it runs. */
export interface AppWebhookInput {
  /** Header names are lower case. */
  headers: { [name: string]: string }
  query: { [name: string]: string }
  /** The body as JSON when it is JSON, else its text; null for an empty body. */
  body: z.infer<typeof bodySchema>
}

export function webhookInput(data: WebhookRequestData): AppWebhookInput {
  const text = data.rawBody.toString('utf8')
  let body: AppWebhookInput['body'] = text
  try {
    body = bodySchema.parse(JSON.parse(text))
  } catch {
    // Not JSON: the mutation gets the text.
  }
  return { headers: Object.fromEntries(data.headers), query: Object.fromEntries(data.query), body: text === '' ? null : body }
}

export class AppWebhooks implements AppLifecyclePart {
  constructor(private readonly apps: Pick<Apps, 'record'>, private readonly webhooks: WebhookRecords) {}

  /** The active version changed: each webhook it declares has a record, and the records of the others go. */
  async activated(app: AppRecord, descriptor: AppDescriptor): Promise<void> {
    const webhookIds = { ...app.webhookIds }
    for (const declared of descriptor.webhooks) {
      const existingId = webhookIds[declared.name]
      const name = `${app.name}: ${declared.name}`
      const updated = existingId
        // A verification with no secret keeps the stored secret when the scheme is the same.
        ? await this.webhooks.update(existingId, { name, verification: declared.verify, replayKey: declared.replayKey ?? null, actions: actionFor(app, declared) }).catch(() => null)
        : null
      if (updated) continue
      try {
        const verification = SECRET_SCHEMES.includes(declared.verify.scheme) ? { ...declared.verify, secret: newSecret(declared.verify.scheme) } : declared.verify
        const created = await this.webhooks.create({ name, verification, replayKey: declared.replayKey ?? null, actions: actionFor(app, declared), organizationId: app.organizationId }, app.createdBy, app.organizationId)
        webhookIds[declared.name] = created.id
      } catch (error) {
        delete webhookIds[declared.name]
        log.warn('app_webhook_not_made', { appId: app.id, webhook: declared.name, error: error instanceof Error ? error.message : String(error) })
      }
    }
    for (const [name, webhookId] of Object.entries(webhookIds)) {
      if (descriptor.webhooks.some((declared) => declared.name === name)) continue
      await this.webhooks.delete(webhookId)
      delete webhookIds[name]
    }
    await saveApp({ ...app, webhookIds, updatedAt: Date.now() })
  }

  async removed(app: AppRecord): Promise<void> {
    for (const webhookId of Object.values(app.webhookIds)) await this.webhooks.delete(webhookId)
  }

  /** The app's webhooks for its owner: the URL to give the other service, and the signing secret the host made. */
  async list(authority: AppAuthority, idOrSlug: string): Promise<AppWebhookView[]> {
    const app = await this.apps.record(authority, idOrSlug)
    const version = app.activeVersion === null ? null : await loadVersion(app.id, app.activeVersion)
    return Promise.all((version?.descriptor.webhooks ?? []).map(async (declared): Promise<AppWebhookView> => {
      const webhookId = app.webhookIds[declared.name] ?? null
      const webhook = webhookId ? await this.webhooks.readWithUrl(webhookId) : null
      if (!webhookId || !webhook) {
        return { name: declared.name, run: declared.run, webhookId: null, enabled: false, urlMode: 'none', url: null, secret: null, problem: 'This webhook could not be made. Deploy the app again, or make it in Settings → Webhooks.' }
      }
      return {
        name: declared.name, run: declared.run, webhookId, enabled: webhook.enabled, urlMode: webhook.url.mode, url: webhook.url.url,
        secret: SECRET_SCHEMES.includes(declared.verify.scheme) ? secretText(webhookId, declared.verify.scheme) : null,
        problem: webhook.url.url ? null : 'This host has no URL for webhooks. Link it to Solus Cloud, or set its public URL in host settings.',
      }
    }))
  }
}

/** The stored secret as text, when it is text a person can paste: the one the host made is. */
function secretText(webhookId: string, scheme: AppWebhookDeclaration['verify']['scheme']): string | null {
  const bytes = verificationSecretOf(readWebhookSecrets(webhookId))
  if (!bytes) return null
  if (scheme === 'standard_webhooks') return `whsec_${bytes.toString('base64')}`
  const text = bytes.toString('utf8')
  return /^[\x21-\x7e]+$/.test(text) ? text : null
}
