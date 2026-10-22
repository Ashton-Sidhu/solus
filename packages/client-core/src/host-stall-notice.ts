import type { HostEventLoopStall } from '@solus/contracts/host-api'

export interface HostStallNotice {
  /** One stall has one key, so a client tells the user about it one time. */
  key: string
  title: string
  description: string
}

/**
 * Why a host stopped answering, from the recent stall it reports in its server
 * info (docs/mobile-connections.md). Desktop and web show it as a toast;
 * mobile shows it in the host's row. Null when the host reports no stall.
 */
export function hostStallNotice(serverId: string, hostLabel: string, stall: HostEventLoopStall | undefined): HostStallNotice | null {
  if (!stall) return null
  const { loadAverage, cpuCount } = stall
  return {
    key: `${serverId}:${stall.endedAt}`,
    title: `${hostLabel} stopped answering for ${Math.max(1, Math.round(stall.durationMs / 1000))} s`,
    description: loadAverage !== undefined && loadAverage > cpuCount
      ? `The computer was overloaded (load ${Math.round(loadAverage)} on ${cpuCount} cores).`
      : `Solus on ${hostLabel} was too busy to answer.`,
  }
}

/** The notice to show now: null when there is none or it was shown before.
 *  Records the key it returns, so a later read of the same stall shows nothing. */
export function unshownHostStallNotice(
  shownKeys: Set<string>,
  serverId: string,
  hostLabel: string,
  stall: HostEventLoopStall | undefined,
): HostStallNotice | null {
  const notice = hostStallNotice(serverId, hostLabel, stall)
  if (!notice || shownKeys.has(notice.key)) return null
  shownKeys.add(notice.key)
  return notice
}
