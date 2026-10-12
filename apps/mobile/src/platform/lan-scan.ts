import { requireOptionalNativeModule } from 'expo'
import {
  DISCOVERY_PORT,
  DISCOVERY_WINDOW_MS,
  discoveredServersFrom,
  discoveryNonce,
  discoveryQuery,
  lanBroadcastAddresses,
  lanSweepAddresses,
  type Ipv4Interface,
} from '@solus/contracts/lan-discovery'
import type { DiscoveredServer } from '@solus/contracts/types'

interface SolusLanDiscoveryModule {
  ipv4Interfaces(): Ipv4Interface[]
  exchange(text: string, addresses: string[], port: number, windowMs: number): Promise<Array<{ address: string; text: string }>>
}

// Optional, so a build made before the module existed scans nothing instead of crashing.
const native = requireOptionalNativeModule<SolusLanDiscoveryModule>('SolusLanDiscovery')

/**
 * One scan of this phone's local network with the hosts' own discovery
 * protocol: a broadcast where the platform allows it, and the same query to
 * each neighbour in the /24, which iOS allows without the multicast
 * entitlement. Null when this build has no native module.
 */
export const scanLocalNetwork: (() => Promise<DiscoveredServer[]>) | undefined = native
  ? async () => {
      const interfaces = native.ipv4Interfaces()
      if (interfaces.length === 0) return []
      const nonce = discoveryNonce()
      const addresses = [...lanBroadcastAddresses(interfaces), ...lanSweepAddresses(interfaces)]
      const packets = await native.exchange(JSON.stringify(discoveryQuery(nonce)), addresses, DISCOVERY_PORT, DISCOVERY_WINDOW_MS)
      return discoveredServersFrom(packets, nonce)
    }
  : undefined
