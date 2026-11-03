import { modelDenial, providerDenial, type SessionPolicy } from '@solus/client-core/policy'
import { AUTO_MODEL_ID } from '@solus/contracts/model-routing'
import type { AgentId } from '@solus/contracts/types'
import type { AgentAvailabilityRow } from '../../../lib/agentAvailability'

/** An agent row with the policy's answer: why the work's policy refuses this agent, or null. */
export interface PolicyAgentRow extends AgentAvailabilityRow {
  policyDenial: string | null
}

/**
 * The agent rows of a picker, with each agent the work's policy does not allow
 * disabled and its reason (plans/030 §6.5, §7). No policy (no host known) locks nothing.
 */
export function withProviderPolicy(rows: readonly AgentAvailabilityRow[], policy: SessionPolicy | null): PolicyAgentRow[] {
  return rows.map((row) => {
    const policyDenial = policy ? providerDenial(policy, row.id) : null
    return policyDenial ? { ...row, enabled: false, reason: policyDenial, policyDenial } : { ...row, policyDenial }
  })
}

/** Why the work's policy refuses `modelId` of `provider`, or null. Auto routes to an allowed model, so it is never refused here. */
export function modelPolicyDenial(policy: SessionPolicy | null, provider: AgentId, modelId: string): string | null {
  if (!policy || modelId === AUTO_MODEL_ID) return null
  return modelDenial(policy, provider, modelId)
}
