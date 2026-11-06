import type { HostResources } from '@solus/contracts/host-resources'
import type { HostBalancePreference, PersonalSettings } from '@solus/contracts/settings'

/** How long a check waits for one host. A host that does not answer is not chosen. */
const CHECK_TIMEOUT_MS = 2_500
/** A host at or over this CPU use, or at or under this free memory, is full. */
const FULL_CPU_UTILIZATION = 0.95
const FULL_MEMORY_AVAILABLE = 0.05

export const HOST_BALANCE_WEIGHTS = { prefer: 100, normal: 50, less: 25, manual: 0 } as const satisfies Record<HostBalancePreference, number>
export const HOST_BALANCE_LABELS = { prefer: 'Prefer', normal: 'Normal', less: 'Less often', manual: 'Manual only' } as const satisfies Record<HostBalancePreference, string>

export type HostBalancing = PersonalSettings['hostBalancing']

/** The name a host keeps on every client. A host that has not said its
 *  installation id uses this client's id, so its preference stays here. */
export function hostBalanceKey(host: { id: string; installationId?: string | null }): string {
  return host.installationId ?? host.id
}

export function hostBalancePreference(balancing: HostBalancing, host: { id: string; installationId?: string | null }): HostBalancePreference {
  return balancing.preferences[hostBalanceKey(host)] ?? 'normal'
}

/** A new value with one host's preference. Normal is the default, so it stores nothing. */
export function withHostBalancePreference(balancing: HostBalancing, host: { id: string; installationId?: string | null }, preference: HostBalancePreference): HostBalancing {
  const key = hostBalanceKey(host)
  const preferences = { ...balancing.preferences }
  if (preference === 'normal') delete preferences[key]
  else preferences[key] = preference
  return { ...balancing, preferences }
}

export interface HostBalanceCandidate {
  hostId: string
  preference: HostBalancePreference
  resources: HostResources | null
}

/**
 * The rule of T3 Code's `chooseLoadBalancedEnvironment` (MIT, see
 * resources/licenses/t3code-resource-monitor.txt). The caller passes only hosts
 * that can take the work. Null when each one is full or did not answer.
 */
export function chooseBalancedHost(candidates: readonly HostBalanceCandidate[]): string | null {
  let selected: string | null = null
  let bestScore = 0
  for (const { hostId, preference, resources } of candidates) {
    const weight = HOST_BALANCE_WEIGHTS[preference]
    if (
      !resources
      || weight <= 0
      || resources.cpuUtilization === null
      || resources.cpuUtilization >= FULL_CPU_UTILIZATION
      || resources.totalMemoryBytes <= 0
      || resources.cpuCount <= 0
    ) continue
    const memoryAvailable = resources.availableMemoryBytes / resources.totalMemoryBytes
    if (memoryAvailable <= FULL_MEMORY_AVAILABLE) continue
    const score = weight * resources.cpuCount * (1 - resources.cpuUtilization) * memoryAvailable
    if (score > bestScore) {
      selected = hostId
      bestScore = score
    }
  }
  return selected
}

/** One host's load, or null when it fails or does not answer in time. */
function readWithin(read: () => Promise<HostResources>, timeoutMs: number): Promise<HostResources | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    read().then(resolve, () => resolve(null)).finally(() => clearTimeout(timer))
  })
}

/** Ask each host for its load now, and choose. A one-time read is fresh by
 *  construction, so this compares no clocks of two machines. */
export async function checkBalancedHost(
  hosts: readonly { hostId: string; preference: HostBalancePreference; read: () => Promise<HostResources> }[],
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<string | null> {
  const candidates = await Promise.all(hosts.map(async ({ hostId, preference, read }) => ({
    hostId,
    preference,
    resources: await readWithin(read, timeoutMs),
  })))
  return chooseBalancedHost(candidates)
}
