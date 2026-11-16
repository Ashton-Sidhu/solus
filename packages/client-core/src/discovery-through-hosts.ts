import type { DiscoveredServer } from '@solus/contracts/types'

/** How long one host has to answer a discovery request; a slower host is left out of that scan. */
export const HOST_DISCOVERY_TIMEOUT_MS = 4_000

/**
 * One discovery list from this device's own answer and the answers of the hosts it
 * is connected to (docs/plans/tailscale-support.md D3, D4). `own` is kept whole: it
 * describes this device's network. From another host only the `tailnet` results are
 * kept; its LAN results describe the host's network, not this device's. The first
 * result for an installation wins, so this device's own route beats one a host saw.
 */
export function mergeDiscovered(own: readonly DiscoveredServer[], fromHosts: readonly (readonly DiscoveredServer[])[]): DiscoveredServer[] {
  const merged = new Map<string, DiscoveredServer>()
  const candidates = [...own, ...fromHosts.flatMap((answer) => answer.filter((server) => server.source === 'tailnet'))]
  for (const server of candidates) {
    if (!merged.has(server.installationId)) merged.set(server.installationId, server)
  }
  return [...merged.values()]
}

/** Each host's answer, in order. A host that fails or does not answer in time gives nothing; it does not stop the others. */
export function askHostsToDiscover(
  asks: readonly (() => Promise<DiscoveredServer[]>)[],
  timers: { setTimeoutFn?: typeof setTimeout; clearTimeoutFn?: typeof clearTimeout } = {},
): Promise<DiscoveredServer[][]> {
  const { setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = timers
  return Promise.all(asks.map((ask) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<DiscoveredServer[]>((resolve) => { timer = setTimeoutFn(() => resolve([]), HOST_DISCOVERY_TIMEOUT_MS) })
    const answer = Promise.resolve().then(ask).catch((): DiscoveredServer[] => [])
    return Promise.race([answer, late]).finally(() => clearTimeoutFn(timer))
  }))
}
