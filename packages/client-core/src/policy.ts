import type { HostPolicies, WorkPolicy } from '@solus/contracts/host-policies'
import {
  LOCAL_POLICY_ORGANIZATION_ID,
  policySourceLabel,
  type ManagedSessionSettingKey,
  type ManagedSessionSettings,
} from '@solus/contracts/policy'
import type { AgentId } from '@solus/contracts/types'

/**
 * What clients compose from the host's policies for display (plans/030 §7).
 * The rules are `HostPolicies` and `WorkPolicy` in contracts; the host enforces
 * them, and these only put their answers into words.
 */

/** The lines under a managed setting, and whether the MDM policy locks it for all work. */
export interface ManagedSettingLines {
  lockedEverywhere: boolean
  lines: string[]
}

/**
 * The line under a managed setting on a page that is not one session's, for each
 * organization that locks it here: "Globex sessions use Opus (managed)". The MDM
 * policy locks the key for all work, so it gives one line and `lockedEverywhere`.
 */
export function managedSettingLines<K extends ManagedSessionSettingKey>(
  policies: HostPolicies,
  organizations: readonly { organizationId: string; name: string }[],
  key: K,
  describe: (value: Exclude<ManagedSessionSettings[K], undefined>) => string,
): ManagedSettingLines {
  // Personal work sees only the MDM policy.
  const mdm = policies.forWork(LOCAL_POLICY_ORGANIZATION_ID).setting(key)
  if (mdm) return { lockedEverywhere: true, lines: [`All sessions on this host use ${describe(mdm.value)} (${policySourceLabel(mdm.source)}).`] }
  const lines: string[] = []
  for (const organization of organizations) {
    if (organization.organizationId === LOCAL_POLICY_ORGANIZATION_ID) continue
    const rule = policies.forWork(organization.organizationId).setting(key)
    if (rule) lines.push(`${organization.name} sessions use ${describe(rule.value)} (managed).`)
  }
  return { lockedEverywhere: false, lines }
}

/**
 * The launch fields a policy owns for `provider` (§6.4). Under a ceiling the host
 * drops all of the person's launch fields; otherwise only the pinned ones are
 * replaced. The summary keeps each pin's field names with its values redacted.
 */
export interface LaunchLock {
  /** Every launch field: binary, arguments, environment, and home paths. */
  all: boolean
  binaryPath: boolean
  launchArgs: boolean
  /** The pinned environment variables by name; the person's others still apply. */
  environment: string[]
  message: string
}

export function launchLock(work: WorkPolicy, provider: AgentId): LaunchLock | null {
  const ceiling = work.ceiling()
  if (ceiling) {
    return {
      all: true,
      binaryPath: true,
      launchArgs: true,
      environment: [],
      message: `${capitalize(policySourceLabel(ceiling.source))} sets how agents start. Your launch settings do not apply.`,
    }
  }
  const { pin, source } = work.launch(provider)
  if (!pin || !source) return null
  return {
    all: false,
    binaryPath: pin.binaryPath !== undefined,
    launchArgs: pin.launchArgs !== undefined,
    environment: pin.environment?.map((variable) => variable.name) ?? [],
    message: `${capitalize(policySourceLabel(source))} pins some launch settings of this provider.`,
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
