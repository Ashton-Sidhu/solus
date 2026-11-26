import type { AppAddress, AppAddressSource, TailscaleServeStatus } from '@solus/contracts/host-api'
import type { AppAddressTestState } from '../../../contexts/connections/connections.store.svelte'
import { tailscaleServeStateText } from './tailscale-serve'

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

/** The name of an address's source, as an open row of Sharing & access shows it. */
export function appAddressSourceLabel(source: AppAddressSource): string {
  switch (source) {
    case 'solus': return 'Solus Cloud'
    case 'tailscale-funnel': return 'Tailscale Funnel'
    case 'tailscale-serve': return 'Tailscale Serve'
    case 'custom': return 'Your own address'
  }
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

/** One row of "Where apps reach this host" on Settings › Sharing & access. */
export interface ReachRow {
  place: 'anywhere' | 'devices' | 'computer'
  label: string
  detail: string
  /** Null when the host has no such address yet. */
  url: string | null
  /** The address the host tests; null for the local one, which needs no test, and for none. */
  source: AppAddressSource | null
  /** The reach its "Set up" gives; null for the local address, which is always there. */
  setupReach: AppAddressReach | null
}

/** Anywhere (an internet address, for cloud apps), your devices (the tailnet), and this computer (the local address). */
export function reachRows(endpoint: { localUrl: string; addresses: readonly AppAddress[] }, hostName: string): ReachRow[] {
  const internet = preferredAppAddress(endpoint.addresses, 'internet')
  const tailnet = endpoint.addresses.find((address) => address.reach === 'tailnet') ?? null
  return [
    { place: 'anywhere', label: 'Anywhere', detail: 'Cloud apps', url: internet?.url ?? null, source: internet?.source ?? null, setupReach: 'internet' },
    { place: 'devices', label: 'Your devices', detail: 'Over Tailscale', url: tailnet?.url ?? null, source: tailnet?.source ?? null, setupReach: 'internet-or-tailnet' },
    { place: 'computer', label: 'This computer', detail: `Apps on ${hostName}`, url: endpoint.localUrl, source: null, setupReach: null },
  ]
}

/** The dot of an address: it answered the host's last test, it did not, or it was not tested. */
export type AddressHealth = 'answers' | 'fails' | 'untested'

export function addressHealth(test: AppAddressTestState | undefined, url: string): AddressHealth {
  if (!test || test.url !== url || test.kind === 'running') return 'untested'
  return test.kind === 'done' && test.reachable ? 'answers' : 'fails'
}

/** What the Tailscale card of the three ways says, and its one action. */
export interface TailscaleCard {
  summary: string
  action: 'turn-on' | 'check' | null
}

export function tailscaleCard(way: TailscaleWay, status: TailscaleServeStatus | null, reach: AppAddressReach, hostName: string): TailscaleCard {
  switch (way) {
    case 'unknown': return { summary: `Install Tailscale on ${hostName} and sign in.`, action: 'check' }
    case 'turn-on-serve': return { summary: 'Tailscale is on. No account needed.', action: 'turn-on' }
    case 'turn-on-funnel': return reach === 'internet' ? { summary: 'Tailscale is on. No account needed.', action: 'turn-on' } : { summary: 'Tailscale Serve is on.', action: 'check' }
    case 'serve-elsewhere':
    case 'funnel-elsewhere': return { summary: `Turn it on from ${hostName} itself.`, action: 'check' }
    case 'serve-waiting': return { summary: `Tailscale Serve: ${status ? tailscaleServeStateText(status.state) : 'starting'}.`, action: 'check' }
    case 'funnel-on': return { summary: 'Funnel is on. The address comes in a moment.', action: 'check' }
  }
}
