import { hostStallNotice } from '@solus/client-core/host-stall-notice'
import type { HostConnections } from '../../hosts/host-connections'
import type { NativeHost } from '../../hosts/host-registry'

/**
 * The line a connected host's row shows when the host reports that it froze
 * (docs/mobile-connections.md). Mobile has no toasts, so the row says it while
 * the connection that read it stays open; a new server session reads it again.
 */
export function hostStallLine(connections: Pick<HostConnections, 'state' | 'connection'>, host: NativeHost): string | null {
  if (connections.state(host.id)?.readiness !== 'ready') return null
  const facts = connections.connection(host.id)?.facts
  if (!facts) return null
  facts.ensure('serverInfo')
  const notice = hostStallNotice(host.id, host.label, facts.value('serverInfo')?.recentEventLoopStall)
  return notice ? `${notice.title}. ${notice.description}` : null
}
