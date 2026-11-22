import type { Activity } from '@solus/contracts/activity'
import { modelLabelFor, type AgentId } from '@solus/contracts/types'
import { PROVIDERS } from './run-settings'

/**
 * A provider pick is composer state; the host hands the session off only when
 * a prompt arrives with another provider (plans/021). These are the rules the
 * transcript reads for it.
 */

export type AgentSwitch = Extract<Activity, { kind: 'agent_switched' }>

/** The pick waits for a send to hand off: the session has a provider thread,
 *  and the picked provider is not the one that owns it. */
export function isHandoffPending(threadProvider: AgentId | null, pickedProvider: AgentId): boolean {
  return threadProvider !== null && threadProvider !== pickedProvider
}

/** A handoff divider's words, as the desktop divider reads them: `from → to`
 *  when both models are known, else the agent the session continued with. */
export function handoffDividerText(activity: Pick<AgentSwitch, 'provider' | 'model' | 'fromProvider' | 'fromModel'>): string {
  const from = activity.fromProvider ? modelLabelFor(activity.fromProvider, activity.fromModel) : null
  const to = modelLabelFor(activity.provider, activity.model)
  if (from && to) return `${from} → ${to}`
  return `Continued with ${PROVIDERS.find((provider) => provider.id === activity.provider)?.label ?? activity.provider}`
}
