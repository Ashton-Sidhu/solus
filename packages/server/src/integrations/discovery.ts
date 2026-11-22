import type { DiscoveredHost, IntegrationDiscoveredEvent, DiscoveredHostResult, IntegrationDiscovery, FoundServerList } from '@solus/contracts/integration-types'
import type { ReachRequest, RemoteHosts } from '../execution/orchestration/remote-hosts'
import { createLogger } from '../logger'

const log = createLogger('integrations', 'discovery.ts')

/**
 * The servers found on this host and on each other host it reaches for the
 * caller (docs/plans/mcp-first-class.md §8.9). This host's own list starts
 * first, so it does not wait for the list of hosts. Each host's answer is
 * published as soon as it comes; a slow or absent host holds back only its
 * own. Another host gets the plain `integrationFoundList` on its `RemoteHost`
 * connection, with its user files only: the project is a path on this host,
 * and that host asks no further.
 */
export async function discoverMcpServers(input: {
  discoveryId: string
  /** This host's name, for its group. */
  selfLabel: string
  refresh: boolean
  /** This host's list for the caller. */
  local(): Promise<FoundServerList>
  hosts: Pick<RemoteHosts, 'list' | 'connect'>
  /** Null: this host reaches no other host for the caller. */
  reach: ReachRequest | null
  publish(event: IntegrationDiscoveredEvent): void
}): Promise<IntegrationDiscovery> {
  const { discoveryId, publish } = input
  const self: DiscoveredHost = { hostId: null, label: input.selfLabel }
  const answer = (host: DiscoveredHost, work: Promise<FoundServerList>) => {
    void work.then(
      (list): DiscoveredHostResult => ({ kind: 'loaded', list }),
      (cause: unknown): DiscoveredHostResult => {
        const message = cause instanceof Error && cause.message.trim() ? cause.message.trim() : 'The host did not answer.'
        if (host.hostId) log.info('discovery_host_failed', { hostId: host.hostId, error: message })
        return /no handler for/i.test(message) ? { kind: 'unsupported' } : { kind: 'failed', message }
      },
    ).then((result) => publish({ discoveryId, host, result }))
  }
  answer(self, input.local())
  const listed = input.reach ? await input.hosts.list(input.reach) : []
  const targets = 'error' in listed ? [] : listed
  for (const target of targets) {
    const remote = input.hosts.connect(target)
    answer(
      { hostId: target.hostId, label: target.label },
      'error' in remote
        ? Promise.reject(new Error(remote.error))
        : remote.call('its MCP config files', () => remote.api.integrationFoundList({ refresh: input.refresh || undefined })),
    )
  }
  return { hosts: [self, ...targets.map((target) => ({ hostId: target.hostId, label: target.label }))] }
}
