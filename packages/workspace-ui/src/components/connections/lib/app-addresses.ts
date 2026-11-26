import type { AppAddress, AppAddressSource, TailscaleServeStatus } from '@solus/contracts/host-api'
import type { AppAddressTestState } from '../../../contexts/connections/connections.store.svelte'

/**
 * The addresses where an outside app reaches a host's `/mcp` (plans/035 §0.8):
 * the Solus tunnel, Tailscale Funnel or Serve, or the person's own ingress.
 * A host does not have to be linked to a Solus account for apps to use it.
 */

/** Who must reach the address: a cloud app needs the internet; an app on another computer can also use the tailnet. */
export type AppAddressReach = 'internet' | 'internet-or-tailnet'

/** The order an app takes a host's addresses in. Serve reaches only the tailnet, so a cloud app never gets it. */
const ADDRESS_PREFERENCE: readonly AppAddressSource[] = ['solus', 'tailscale-funnel', 'custom', 'tailscale-serve']

/** The address an app uses for this reach, in the order of preference; null when the host has none. */
export function preferredAppAddress(addresses: readonly AppAddress[], reach: AppAddressReach): AppAddress | null {
  for (const source of ADDRESS_PREFERENCE) {
    const address = addresses.find((candidate) => candidate.source === source)
    if (address && (reach === 'internet-or-tailnet' || address.reach === 'internet')) return address
  }
  return null
}

/** The name of an address's source, as the dialog and Sharing & access show it. */
export function appAddressSourceLabel(source: AppAddressSource): string {
  switch (source) {
    case 'solus': return 'Solus Cloud'
    case 'tailscale-funnel': return 'Tailscale Funnel'
    case 'tailscale-serve': return 'Tailscale Serve'
    case 'custom': return 'Your own address'
  }
}

export function appAddressReachLabel(reach: AppAddress['reach']): string {
  return reach === 'internet' ? 'Internet' : 'Your tailnet'
}

/** The host could not reach its own address from itself (a router without NAT loopback), which says nothing about other devices. */
export function isHairpinReason(reason: string | null): boolean {
  return reason !== null && /hairpin|nat loopback/i.test(reason)
}

/** The result of the last test of an address, in one line; null when it was not tested. */
export function appAddressTestText(test: AppAddressTestState | undefined, url: string): string | null {
  if (!test || test.url !== url) return null
  switch (test.kind) {
    case 'running': return 'Testing…'
    case 'error': return `The test could not run: ${test.message}`
    case 'done': return test.reachable ? 'Answers from outside' : test.reason ?? 'Does not answer from outside'
  }
}

/**
 * What the Tailscale choice of the gate offers. Serve gives the host an https
 * address on the tailnet; Funnel opens that address to the internet. Both need
 * local reach (`host.local.reach`), so only the owner on the host's computer
 * changes them here; anyone else sees where to do it.
 */
export type TailscaleWay =
  /** Tailscale did not answer: it is not installed or not signed in on the host. */
  | 'unknown'
  | 'turn-on-serve'
  | 'serve-elsewhere'
  /** Serve is on and Tailscale has not given the address yet, or it needs attention. */
  | 'serve-waiting'
  | 'turn-on-funnel'
  | 'funnel-elsewhere'
  /** Funnel is on; the address comes once Tailscale serves it. */
  | 'funnel-on'

export function tailscaleWay(status: TailscaleServeStatus | null, mayReachLocally: boolean): TailscaleWay {
  if (!status) return 'unknown'
  if (!status.enabled) return mayReachLocally ? 'turn-on-serve' : 'serve-elsewhere'
  if (status.state !== 'active') return 'serve-waiting'
  if (!status.funnel) return mayReachLocally ? 'turn-on-funnel' : 'funnel-elsewhere'
  return 'funnel-on'
}

/** Why a "Use your own address" value cannot be saved; null when it can. Empty clears the address. */
export function publicAddressProblem(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return 'Type a full address, for example https://solus.example.com.'
  }
  return url.protocol === 'https:' ? null : 'Use an https address. Apps sign in only over https.'
}

/** The port of the host's local address, which the person's own ingress proxies to; null when it has none. */
export function localPortOf(localUrl: string): string | null {
  try {
    const url = new URL(localUrl)
    return url.port || (url.protocol === 'https:' ? '443' : '80')
  } catch {
    return null
  }
}

/** One address on Settings › Sharing & access. `source` is null for the local one, which needs no test. */
export interface AppAddressRow {
  source: AppAddressSource | null
  label: string
  url: string
  reach: string
}

/** Every address of a host for outside apps: the one on its own computer first, then the others in the order an app takes them. */
export function appAddressRows(endpoint: { localUrl: string; addresses: readonly AppAddress[] }): AppAddressRow[] {
  const others = [...endpoint.addresses].sort((a, b) => ADDRESS_PREFERENCE.indexOf(a.source) - ADDRESS_PREFERENCE.indexOf(b.source))
  return [
    { source: null, label: "On the host's computer", url: endpoint.localUrl, reach: 'This computer' },
    ...others.map((address) => ({ source: address.source, label: appAddressSourceLabel(address.source), url: address.url, reach: appAddressReachLabel(address.reach) })),
  ]
}
