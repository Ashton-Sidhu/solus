import { MANAGED_LINK_ENV, managedLinkEnvSchema, type EnrollHostResponse } from '@solus/contracts/uplink'
import { createLogger } from '../logger'

const log = createLogger('main', 'managed-mode')

/**
 * Managed mode (docs/plans/managed-hosts.md §1): how the server boots on a host the
 * control plane provisioned for an organization. The host learns it from its own
 * environment, once, and it holds for the life of the process: nothing is trusted by
 * network position, pairing does not exist, the link is system-owned, and every
 * caller arrives through the tunnel with a grant.
 */

let managed: boolean | undefined
let managedLink: EnrollHostResponse | null | undefined

export function isManagedHost(): boolean {
  if (managed === undefined) managed = process.env.SOLUS_MANAGED === '1'
  return managed
}

/**
 * The link the control plane put in this machine's environment (§2), read once. It
 * is deleted from `process.env` on that first read: agent processes inherit the
 * environment and must never see the tokens. Null on a personal host, or when the
 * environment carries nothing usable (which is logged: the host then has no link).
 */
export function readManagedLinkEnv(): EnrollHostResponse | null {
  if (managedLink !== undefined) return managedLink
  const raw = process.env[MANAGED_LINK_ENV]?.trim()
  delete process.env[MANAGED_LINK_ENV]
  managedLink = null
  if (!raw) return managedLink
  try {
    const parsed = managedLinkEnvSchema.safeParse(JSON.parse(raw))
    if (parsed.success) managedLink = parsed.data
    else log.warn('managed_link_env_invalid', { issues: parsed.error.issues.map((issue) => issue.path.join('.')) })
  } catch (err) {
    log.warn('managed_link_env_invalid', { error: err instanceof Error ? err.message : String(err) })
  }
  return managedLink
}

/** Process-wide consequences of managed mode, applied before anything else at boot. */
export function applyManagedMode(): void {
  if (!isManagedHost()) return
  // Strip the link tokens before any child process can inherit them.
  const link = readManagedLinkEnv()
  log.info('managed_mode_applied', { linkInEnv: link !== null })
}

/** Tests only: forget the cached environment so the next read sees the test's. */
export function resetManagedModeForTests(): void {
  managed = undefined
  managedLink = undefined
}
