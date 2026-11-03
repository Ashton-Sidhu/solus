import { resolveHostKey, type PolicySet } from '@solus/contracts/policy'

/** What the host's `updates` key asks of the desktop updater (plans/030 §6.8). */
export interface UpdatePolicy {
  /** "<Name> manages Solus updates." when the policy turns updates off; null otherwise. */
  managedMessage: string | null
  /** A generic feed that replaces the Solus releases; null for the package.json feed. */
  feedUrl: string | null
}

export function updatePolicyOf(set: PolicySet): UpdatePolicy {
  const rule = resolveHostKey(set, 'updates')
  if (!rule) return { managedMessage: null, feedUrl: null }
  return {
    managedMessage: rule.value.mode === 'off' ? `${rule.source.document.organization.name} manages Solus updates.` : null,
    feedUrl: rule.value.feedUrl ?? null,
  }
}
