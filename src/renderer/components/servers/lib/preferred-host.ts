import { LOCAL_SERVER_ID } from '@client-core/server-registry'
import type { ServerItem, ServerItemStatus } from '../../../contexts'
import type { ProjectIdentity } from '../../../../shared/types'
import { checkoutForRepo } from '../run-on'

export interface PreferredHostResolutionInput {
  repoKey: string | null
  hasResolved: boolean
  isLocked: boolean
  currentServerId: string | null | undefined
  pendingServerId: string | null | undefined
  preferredServerId: string | null
  preferredServer: ServerItem | undefined
  preferredStatus: ServerItemStatus | null
  preferredIdentities: ProjectIdentity[]
}

export type PreferredHostResolution =
  | { done: false }
  | { done: true; target?: ServerItem }

/**
 * Resolves a remembered host only when it can receive this repository now.
 * A saved/connecting host stays unresolved so the probe can supply its verdict.
 */
export function resolvePreferredHost(input: PreferredHostResolutionInput): PreferredHostResolution {
  const {
    repoKey,
    hasResolved,
    isLocked,
    currentServerId,
    pendingServerId,
    preferredServerId,
    preferredServer,
    preferredStatus,
    preferredIdentities,
  } = input

  if (!repoKey || hasResolved || isLocked || !currentServerId) return { done: false }
  if (pendingServerId || currentServerId !== LOCAL_SERVER_ID) return { done: true }
  if (!preferredServerId || preferredServerId === LOCAL_SERVER_ID || !preferredServer) return { done: true }
  if (preferredStatus === 'saved' || preferredStatus === 'connecting') return { done: false }
  if (preferredStatus !== 'online') return { done: true }
  if (!checkoutForRepo(preferredIdentities, repoKey)) return { done: true }
  return { done: true, target: preferredServer }
}
