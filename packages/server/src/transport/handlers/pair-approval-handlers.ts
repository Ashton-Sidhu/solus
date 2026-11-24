import { z } from 'zod'
import type { HostEventMap } from '@solus/contracts/host-events'
import type { PairApprovals } from '../../admission/pair-approvals'
import type { SolusServer } from '../server'

/**
 * The owner's side of approval requests (docs/plans/add-machine-card.md). The
 * gate admits both methods for `host.local.reach` only, and the event audience
 * sends `host.pairApprovalsChanged` to those connections only.
 */
export function registerPairApprovalHandlers(
  server: SolusServer,
  approvals: PairApprovals,
  deps: { broadcast: (topic: 'host.pairApprovalsChanged', payload: HostEventMap['host.pairApprovalsChanged']) => void },
): () => void {
  server.register('hostsPairApprovals', () => approvals.list())
  server.register('hostsPairApprovalDecide', ([requestId, decision]) =>
    approvals.decide(z.string().min(1).max(128).parse(requestId), z.enum(['approve', 'deny']).parse(decision)))
  return approvals.subscribe((open) => deps.broadcast('host.pairApprovalsChanged', { approvals: open }))
}
