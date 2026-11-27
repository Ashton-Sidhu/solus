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

/**
 * The one address "Where apps reach this host" shows (docs/outside-apps.md):
 * the internet address cloud apps use, which your devices use too; else a
 * tailnet address, which reaches your devices only; else none.
 */
/** The address the section shows, and whether it reaches your devices only. */
export interface HostAppAddress {
  address: AppAddress | null
  isDevicesOnly: boolean
}

export function hostAppAddress(addresses: readonly AppAddress[]): HostAppAddress {
  const internet = preferredAppAddress(addresses, 'internet')
  if (internet) return { address: internet, isDevicesOnly: false }
  const tailnet = addresses.find((address) => address.reach === 'tailnet') ?? null
  return { address: tailnet, isDevicesOnly: tailnet !== null }
}

/** An address as the page shows it: without the scheme, which Copy keeps. */
export function shownAppAddress(url: string): string {
  return url.replace(/^https?:\/\//, '')
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
    case 'turn-on-serve': return {
      summary: reach === 'internet' ? 'Give cloud apps a public HTTPS address with Funnel.' : 'Give devices on your tailnet an HTTPS address with Serve.',
      action: 'turn-on',
    }
    case 'turn-on-funnel':
    case 'funnel-elsewhere': {
      if (reach === 'internet-or-tailnet') return { summary: 'Tailscale Serve is on for your devices.', action: 'check' }
      return way === 'turn-on-funnel'
        ? { summary: 'Tailscale Serve is on for your devices. Turn on Funnel to give cloud apps a public address.', action: 'turn-on' }
        : { summary: `Tailscale Serve is on for your devices. Turn on Funnel from ${hostName} itself.`, action: 'check' }
    }
    case 'serve-elsewhere': return { summary: `Turn it on from ${hostName} itself.`, action: 'check' }
    case 'serve-waiting': return { summary: `Tailscale Serve: ${status ? tailscaleServeStateText(status.state) : 'starting'}.`, action: 'check' }
    case 'funnel-on': return {
      summary: status?.url ? 'Tailscale Funnel is on. A public HTTPS address is available.' : 'Tailscale Funnel is on. Waiting for a public address.',
      action: 'check',
    }
  }
}
