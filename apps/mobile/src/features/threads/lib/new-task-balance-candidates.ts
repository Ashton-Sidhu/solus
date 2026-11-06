import { hostBalancePreference, type HostBalancing } from '@solus/client-core/host-balance'
import { awaitsManagedCompute, type SavedServerUplink } from '@solus/client-core/server-registry'
import type { HostBalancePreference } from '@solus/contracts/settings'

export interface BalanceableEnvironment {
  readonly hostId: string
  readonly projectPath: string
}

export interface NewTaskBalanceHost {
  readonly id: string
  readonly ready: boolean
  readonly uplink?: SavedServerUplink
  readonly runsAgent: boolean
}

/** The same rule as desktop's `balanceCandidates`: `environments` already holds
 *  only hosts that have the project, so a host never needs a clone. */
export function newTaskBalanceCandidates<Environment extends BalanceableEnvironment>(
  environments: readonly Environment[],
  hosts: readonly NewTaskBalanceHost[],
  balancing: HostBalancing,
): (Environment & { preference: HostBalancePreference })[] {
  return environments.flatMap((environment) => {
    const host = hosts.find((candidate) => candidate.id === environment.hostId)
    if (!host?.ready || !host.runsAgent || awaitsManagedCompute(host.uplink)) return []
    const preference = hostBalancePreference(balancing, host)
    return preference === 'manual' ? [] : [{ ...environment, preference }]
  })
}

/** Check now when the picker asked, or when a new task has no choice yet. A
 *  saved draft is one the person came back to: its host stays until they ask. */
export function shouldBalanceNewTask(input: { balanceRequest: number | undefined; hostChoice: 'auto' | 'manual' | undefined; startedEmpty: boolean }): boolean {
  return input.balanceRequest !== undefined || (input.hostChoice === undefined && input.startedEmpty)
}

export function newTaskHostLabel(state: 'idle' | 'checking' | 'unavailable', hostLabel: string | undefined): string {
  if (state === 'checking') return 'Checking hosts…'
  if (state === 'unavailable') return 'Auto balance unavailable'
  return hostLabel ?? 'Host'
}

export interface NewTaskBalanceDraft {
  readonly hostId: string
  readonly draftKey: string
  readonly text: string
  /** Files attached or uploading. They are on this host and cannot move. */
  readonly attachments: number
  readonly submitting: boolean
  /** The picker's Auto balance row asked: a person who asks has more say than a check. */
  readonly requested: boolean
}

export interface NewTaskBalancePorts {
  saveDraft: (hostId: string, draftKey: string, text: string) => void
  setParams: (params: { hostId?: string; projectPath?: string; hostChoice: 'auto' | 'manual'; balanceRequest: undefined }) => void
}

/**
 * Act on what the check chose. Writing keeps a draft where it is: a check must
 * not move the words under a person, so the host stays as `manual`, because
 * the check did not choose it. Only asking moves a written draft, and
 * attachments stay on their host even then. False: asked, and it could not move.
 */
export function settleNewTaskBalance(
  choice: BalanceableEnvironment,
  draft: NewTaskBalanceDraft,
  ports: NewTaskBalancePorts,
): boolean {
  if (choice.hostId === draft.hostId) {
    ports.setParams({ hostChoice: 'auto', balanceRequest: undefined })
    return true
  }
  const held = draft.attachments > 0 || draft.submitting
  if (held && draft.requested) return false
  if (!draft.requested && (held || draft.text.trim() !== '')) {
    ports.setParams({ hostChoice: 'manual', balanceRequest: undefined })
    return true
  }
  ports.saveDraft(draft.hostId, draft.draftKey, '')
  ports.saveDraft(choice.hostId, `new-task:${choice.projectPath}`, draft.text)
  ports.setParams({ hostId: choice.hostId, projectPath: choice.projectPath, hostChoice: 'auto', balanceRequest: undefined })
  return true
}
