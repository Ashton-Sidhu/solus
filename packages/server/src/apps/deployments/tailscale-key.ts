import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { createLogger } from '../../logger'
import { dataDir } from '../../platform/paths'
import { secretStore } from '../../platform/secrets'

const log = createLogger('apps', 'tailscale-key.ts')

/**
 * The Tailscale auth key of this host (docs/plans/app-deploy.md §8.2): what
 * the sidecar of a copy joins the tailnet with. It is in the secret store of
 * the host, set in Settings, and never read back by a client. The env var
 * `SOLUS_TAILSCALE_AUTHKEY` of the server is used when the store has none.
 */

const KEY = 'app-tailscale-key'
const storedSchema = z.object({ key: z.string().min(1) })

function path(): string {
  const dir = join(dataDir(), 'app-secrets')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return join(dir, 'tailscale.bin')
}

export function tailscaleAuthKey(): string | null {
  return secretStore().loadJson(KEY, path(), storedSchema)?.key ?? (process.env.SOLUS_TAILSCALE_AUTHKEY || null)
}

/** Sets the key, or removes the stored one with null. */
export function setTailscaleAuthKey(value: string | null): void {
  if (value === null) secretStore().remove(KEY, path())
  else secretStore().saveJson(KEY, path(), { key: value })
  log.info('app_tailscale_key_changed', { isSet: value !== null })
}
