import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { dataDir } from '../platform/paths'
import { secretStore } from '../platform/secrets'

/**
 * An app's secrets (docs/plans/apps.md §4.4): the values its owner gave for
 * the names it declares. In the host's secret store, never in a table and
 * never in the app's data: one entry for each app, as a webhook's secrets are
 * (`data/webhooks/webhook-secrets.ts`). Only the app's runner reads a value.
 */

const storedSecretsSchema = z.record(z.string(), z.string())
export interface AppSecretValues { [name: string]: string }

function keyOf(appId: string): string {
  return `app-${appId}`
}

function electronPath(appId: string): string {
  const dir = join(dataDir(), 'app-secrets')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return join(dir, `${appId}.bin`)
}

/** Where a deployment reads an app's secrets: its env vars, not a secret store (docs/plans/app-deploy.md decision 14). Null on a host. */
let source: ((appId: string) => AppSecretValues) | null = null

/** Installed once at boot by the runtime of a deployment; `null` takes it out again. */
export function useAppSecretSource(read: ((appId: string) => AppSecretValues) | null): void {
  source = read
}

export function readAppSecrets(appId: string): AppSecretValues {
  if (source) return source(appId)
  return secretStore().loadJson(keyOf(appId), electronPath(appId), storedSecretsSchema) ?? {}
}

/** Sets one secret, or clears it with `null`. */
export function writeAppSecret(appId: string, name: string, value: string | null): void {
  if (source) throw new Error('A deployment gets its secrets from its env vars. Set the secret in Solus.')
  const secrets = readAppSecrets(appId)
  if (value === null) delete secrets[name]
  else secrets[name] = value
  if (Object.keys(secrets).length === 0) secretStore().remove(keyOf(appId), electronPath(appId))
  else secretStore().saveJson(keyOf(appId), electronPath(appId), secrets)
}

export function removeAppSecrets(appId: string): void {
  if (source) return
  secretStore().remove(keyOf(appId), electronPath(appId))
}
