import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { dataDir } from '../../platform/paths'
import { secretStore } from '../../platform/secrets'

/**
 * A webhook's URL token and verification secret (docs/plans/webhooks.md §5):
 * in the host's secret store, never in a table. One entry for each webhook.
 */

const storedSecretsSchema = z.object({
  token: z.string().min(1),
  /** The verification secret's bytes, base64. */
  secret: z.string().optional(),
})
export type WebhookSecrets = z.infer<typeof storedSecretsSchema>

function keyOf(webhookId: string): string {
  return `webhook-${webhookId}`
}

function electronPath(webhookId: string): string {
  const dir = join(dataDir(), 'webhook-secrets')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return join(dir, `${webhookId}.bin`)
}

/** A new URL token: 32 random bytes, base64url. */
export function newWebhookToken(): string {
  return randomBytes(32).toString('base64url')
}

export function readWebhookSecrets(webhookId: string): WebhookSecrets | null {
  return secretStore().loadJson(keyOf(webhookId), electronPath(webhookId), storedSecretsSchema)
}

export function writeWebhookSecrets(webhookId: string, secrets: WebhookSecrets): void {
  secretStore().saveJson(keyOf(webhookId), electronPath(webhookId), secrets)
}

export function removeWebhookSecrets(webhookId: string): void {
  secretStore().remove(keyOf(webhookId), electronPath(webhookId))
}

export function verificationSecretOf(secrets: WebhookSecrets | null): Buffer | null {
  return secrets?.secret ? Buffer.from(secrets.secret, 'base64') : null
}
