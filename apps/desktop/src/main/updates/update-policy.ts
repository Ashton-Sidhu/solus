import type { HostPolicies } from '@solus/contracts/host-policies'

/** What the host's `updates` key asks of the desktop updater (plans/030 §6.8). */
export interface UpdatePolicy {
  /** "<Name> manages Solus updates." when the policy turns updates off; null otherwise. */
  managedMessage: string | null
  /** A generic feed that replaces the Solus releases; null for the package.json feed. */
  feedUrl: string | null
}

export function updatePolicyOf(policies: HostPolicies): UpdatePolicy {
  return {
    managedMessage: policies.updatesManagedMessage(),
    feedUrl: policies.hostSetting('updates')?.value.feedUrl ?? null,
  }
}
