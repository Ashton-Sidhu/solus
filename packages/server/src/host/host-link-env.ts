import { HOST_LINK_ENV, hostLinkEnvSchema, type EnrollHostResponse } from '@solus/contracts/uplink'
import { createLogger } from '../logger'

const log = createLogger('main', 'host-link-env')

let hostLink: EnrollHostResponse | null | undefined

/**
 * The link a provisioning control plane put in this machine's environment
 * (managed-hosts.md §2), read once. It is deleted from `process.env` on that
 * first read: agent processes inherit the environment and must never see the
 * tokens. Null on a machine a person linked, or when the environment carries
 * nothing usable (which is logged: the host then has no link from it).
 */
export function readHostLinkEnv(): EnrollHostResponse | null {
  if (hostLink !== undefined) return hostLink
  const raw = process.env[HOST_LINK_ENV]?.trim()
  delete process.env[HOST_LINK_ENV]
  hostLink = null
  if (!raw) return hostLink
  try {
    const parsed = hostLinkEnvSchema.safeParse(JSON.parse(raw))
    if (parsed.success) hostLink = parsed.data
    else log.warn('host_link_env_invalid', { issues: parsed.error.issues.map((issue) => issue.path.join('.')) })
  } catch (err) {
    log.warn('host_link_env_invalid', { error: err instanceof Error ? err.message : String(err) })
  }
  return hostLink
}

/** Tests only: forget the cached environment so the next read sees the test's. */
export function resetHostLinkEnvForTests(): void {
  hostLink = undefined
}
