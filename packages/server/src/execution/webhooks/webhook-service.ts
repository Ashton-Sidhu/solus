import { createHash, randomUUID } from 'node:crypto'
import {
  SECRET_SCHEMES,
  WEBHOOK_CLOUD_ORIGIN,
  WEBHOOK_RECEIVER_PREFIX,
  webhookCreateInputSchema,
  webhookUpdateInputSchema,
  type Webhook,
  type WebhookAction,
  type WebhookCreateInput,
  type WebhookUpdateInput,
  type WebhookUrl,
  type WebhookVerification,
  type WebhookVerificationInput,
  type WebhookWithUrl,
} from '@solus/contracts/webhooks'
import type { Attribution } from '@solus/contracts/user'
import { createLogger } from '../../logger'
import { creatorKeyOf } from '../../data/automations/automations-store'
import {
  addLostRequests,
  deleteWebhook,
  deliveryStats,
  insertWebhook,
  listWebhooks,
  loadWebhook,
  saveWebhook,
  type WebhookRecord,
} from '../../data/webhooks/webhook-store'
import {
  newWebhookToken,
  readWebhookSecrets,
  removeWebhookSecrets,
  writeWebhookSecrets,
  type WebhookSecrets,
} from '../../data/webhooks/webhook-secrets'
import { hostUserKey } from '../../host/host-user'
import { refusedAsUnverified } from './receiver'
import { decodeStandardWebhooksSecret, publicKeyOf } from './verification'
import { emitWebhookChanged } from './webhook-events'

const log = createLogger('webhooks', 'webhook-service.ts')

/**
 * The webhooks of one host as people and agents change them (docs/plans/webhooks.md
 * §2.2, §3.6, §3.7, §5): the store, the secret store, and the URL the host gives.
 * A list never gives the token; create, rotate, and the owner's read give it.
 */

/** What decides a webhook's URL mode (plan §2.2). */
export interface WebhookUrlFacts {
  /** This host's ID in Solus Cloud; null while it is not registered. */
  hostId(): string | null
  /** The host is linked and the forwarder serves it: the link answer gave a forwarder secret (plan §2.5). */
  cloudReady(): boolean
  /** The host public URL, without a trailing slash; null when it is not set. */
  publicUrl(): string | null
}

export interface WebhookServiceDeps {
  urls: WebhookUrlFacts
  isPausedByAdmin(webhookId: string): boolean
  allowsUnverifiedWebhooks(organizationId: string): boolean
  /** A one-use `secretRef` from `request_secret` (plan §3.6), for the session that asked; null when it is not valid. */
  takeSecretRef?(secretRef: string, sessionId: string | null): string | null
}

export class WebhookInputError extends Error {}

export function webhookUrl(webhookId: string, token: string, facts: WebhookUrlFacts): WebhookUrl {
  const path = `${WEBHOOK_RECEIVER_PREFIX}${webhookId}/${token}`
  const hostId = facts.hostId()
  if (facts.cloudReady() && hostId) return { mode: 'cloud', path, url: `${WEBHOOK_CLOUD_ORIGIN}/${hostId}/${webhookId}/${token}` }
  const publicUrl = facts.publicUrl()
  if (publicUrl) return { mode: 'direct', path, url: `${publicUrl}${path}` }
  return { mode: 'none', path, url: null }
}

function urlHash(url: string): string {
  return createHash('sha256').update(url).digest('hex')
}

/** The verification secret's bytes, as the secret store keeps them: base64. */
function secretBytes(verification: WebhookVerificationInput, secret: string): string {
  if (verification.scheme === 'standard_webhooks') return decodeStandardWebhooksSecret(secret).toString('base64')
  return Buffer.from(secret, verification.secretEncoding === 'base64' ? 'base64' : 'utf8').toString('base64')
}

/** The stored settings: the input without its secret fields. */
function storedVerification(input: WebhookVerificationInput): WebhookVerification {
  const { secret: _secret, secretRef: _secretRef, secretEncoding: _encoding, ...verification } = input
  return verification
}

function assertActions(actions: WebhookAction[]): void {
  const ids = new Set<string>()
  for (const action of actions) {
    if (ids.has(action.id)) throw new WebhookInputError(`Two actions have the ID "${action.id}". Give each action its own ID.`)
    ids.add(action.id)
    if (!action.template.trim()) throw new WebhookInputError(`Action "${action.id}" has no template.`)
  }
}

export function createWebhookService(deps: WebhookServiceDeps) {
  /** The secret a create or an update gives: the value, or the value behind a one-use `secretRef`. */
  function givenSecret(input: WebhookVerificationInput, sessionId: string | null): string | null {
    if (input.secret) return input.secret
    if (!input.secretRef) return null
    const value = deps.takeSecretRef?.(input.secretRef, sessionId) ?? null
    if (value === null) throw new WebhookInputError('The secretRef is not valid. It works once, only in the session that asked, for 15 minutes. Ask for the secret again with request_secret.')
    return value
  }

  function assertVerification(input: WebhookVerificationInput, organizationId: string, hasSecret: boolean): void {
    if (SECRET_SCHEMES.includes(input.scheme) && !hasSecret) throw new WebhookInputError(`The ${input.scheme} scheme needs a secret.`)
    if (input.scheme === 'public_key') {
      try {
        publicKeyOf(input.algorithm, input.publicKey)
      } catch {
        throw new WebhookInputError('The public key is not valid. Give a PEM key, or the raw key in hex or base64.')
      }
    }
    if (refusedAsUnverified({ verification: input, organizationId }, deps.allowsUnverifiedWebhooks)) {
      throw new WebhookInputError('This organization does not allow unverified webhooks. Choose a verification scheme.')
    }
  }

  async function view(record: WebhookRecord, now = Date.now()): Promise<Webhook> {
    return (await views([record], now))[0]
  }

  async function views(records: WebhookRecord[], now = Date.now()): Promise<Webhook[]> {
    const stats = await deliveryStats(records.map((record) => record.id), now)
    return records.map((record) => {
      const secrets = readWebhookSecrets(record.id)
      const url = secrets ? webhookUrl(record.id, secrets.token, deps.urls) : null
      const stat = stats.get(record.id)
      return {
        id: record.id,
        organizationId: record.organizationId,
        name: record.name,
        enabled: record.enabled,
        pausedByAdmin: deps.isPausedByAdmin(record.id),
        project: record.project,
        verification: record.verification,
        replayKey: record.replayKey,
        actions: record.actions,
        urlMode: url?.mode ?? 'none',
        urlChanged: !!url?.url && record.copiedUrlHash !== null && record.copiedUrlHash !== urlHash(url.url),
        lostCount: record.lostCount,
        lostAt: record.lostAt,
        lastDelivery: stat?.lastDelivery ?? null,
        deliveries24h: stat?.deliveries24h ?? 0,
        createdBy: record.createdBy,
        ownerKey: record.ownerKey,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }
    })
  }

  function withUrl(webhook: Webhook, secrets: WebhookSecrets): WebhookWithUrl {
    return { ...webhook, url: webhookUrl(webhook.id, secrets.token, deps.urls) }
  }

  async function announce(record: WebhookRecord): Promise<Webhook> {
    const webhook = await view(record)
    emitWebhookChanged({ kind: 'saved', webhook })
    return webhook
  }

  return {
    views,

    async list(where?: Parameters<typeof listWebhooks>[0]): Promise<Webhook[]> {
      return views(await listWebhooks(where))
    },

    async read(id: string): Promise<Webhook | null> {
      const record = await loadWebhook(id)
      return record ? view(record) : null
    },

    /** The owner's read: with the URL and its token. */
    async readWithUrl(id: string): Promise<WebhookWithUrl | null> {
      const record = await loadWebhook(id)
      const secrets = record ? readWebhookSecrets(id) : null
      return record && secrets ? withUrl(await view(record), secrets) : null
    },

    async create(rawInput: WebhookCreateInput, createdBy: Attribution, organizationId: string, sessionId: string | null = null): Promise<WebhookWithUrl> {
      const input = webhookCreateInputSchema.parse(rawInput)
      assertActions(input.actions)
      const secret = givenSecret(input.verification, sessionId)
      const organization = input.organizationId ?? organizationId
      assertVerification(input.verification, organization, secret !== null)
      const now = Date.now()
      const record: WebhookRecord = {
        id: randomUUID(),
        organizationId: organization,
        ownerKey: await creatorKeyOf(createdBy) ?? hostUserKey(),
        name: input.name,
        enabled: input.enabled ?? true,
        project: input.project ?? null,
        verification: storedVerification(input.verification),
        replayKey: input.replayKey ?? null,
        actions: input.actions,
        createdBy,
        copiedUrlHash: null,
        lostCount: 0,
        lostAt: null,
        createdAt: now,
        updatedAt: now,
      }
      const secrets: WebhookSecrets = { token: newWebhookToken() }
      if (secret) secrets.secret = secretBytes(input.verification, secret)
      writeWebhookSecrets(record.id, secrets)
      try {
        await insertWebhook(record)
      } catch (err) {
        removeWebhookSecrets(record.id)
        throw err
      }
      log.info('webhook_created', { webhookId: record.id, scheme: record.verification.scheme, actions: record.actions.length })
      return withUrl(await announce(record), secrets)
    },

    async update(id: string, rawPatch: WebhookUpdateInput, sessionId: string | null = null): Promise<Webhook | null> {
      const patch = webhookUpdateInputSchema.parse(rawPatch)
      const record = await loadWebhook(id)
      const secrets = record ? readWebhookSecrets(id) : null
      if (!record || !secrets) return null
      if (patch.actions) {
        assertActions(patch.actions)
        record.actions = patch.actions
      }
      if (patch.verification) {
        const given = givenSecret(patch.verification, sessionId)
        // A verification without a secret keeps the stored one only for the same scheme.
        const keepsSecret = given === null && patch.verification.scheme === record.verification.scheme && !!secrets.secret
        assertVerification(patch.verification, record.organizationId, given !== null || keepsSecret)
        record.verification = storedVerification(patch.verification)
        if (given) secrets.secret = secretBytes(patch.verification, given)
        else if (!keepsSecret) delete secrets.secret
        writeWebhookSecrets(id, secrets)
      }
      if (patch.name !== undefined) record.name = patch.name
      if (patch.project !== undefined) record.project = patch.project
      if (patch.enabled !== undefined) record.enabled = patch.enabled
      if (patch.replayKey !== undefined) record.replayKey = patch.replayKey
      if (patch.copiedUrl !== undefined) {
        const url = webhookUrl(id, secrets.token, deps.urls).url
        if (url && patch.copiedUrl === url) record.copiedUrlHash = urlHash(url)
      }
      record.updatedAt = Date.now()
      await saveWebhook(record)
      log.info('webhook_updated', { webhookId: id, enabled: record.enabled })
      return announce(record)
    },

    /** A new token: the old URL stops working at once. */
    async rotate(id: string): Promise<WebhookWithUrl | null> {
      const record = await loadWebhook(id)
      const secrets = record ? readWebhookSecrets(id) : null
      if (!record || !secrets) return null
      secrets.token = newWebhookToken()
      writeWebhookSecrets(id, secrets)
      record.copiedUrlHash = null
      record.updatedAt = Date.now()
      await saveWebhook(record)
      log.info('webhook_rotated', { webhookId: id })
      return withUrl(await announce(record), secrets)
    },

    /** Tells clients that a webhook changed outside an edit: an admin pause, or lost requests. */
    async announce(id: string): Promise<void> {
      const record = await loadWebhook(id)
      if (record) await announce(record)
    },

    /** Adds the forwarder's lost counts from one drain (plan §2.3). */
    async recordLost(lost: { webhookId: string; count: number }[], at = Date.now()): Promise<void> {
      for (const entry of lost) {
        if (entry.count > 0 && await addLostRequests(entry.webhookId, entry.count, at)) {
          log.info('webhook_requests_lost', { webhookId: entry.webhookId, count: entry.count })
          await this.announce(entry.webhookId)
        }
      }
    },

    async delete(id: string): Promise<boolean> {
      const deleted = await deleteWebhook(id)
      removeWebhookSecrets(id)
      if (deleted) {
        emitWebhookChanged({ kind: 'deleted', webhookId: id })
        log.info('webhook_deleted', { webhookId: id })
      }
      return deleted
    },
  }
}

export type WebhookService = ReturnType<typeof createWebhookService>
