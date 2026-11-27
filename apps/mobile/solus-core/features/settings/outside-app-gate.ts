import type { AppAddress } from '@solus/contracts/host-api'
import { appAddressesOf, appAddressSourceLabel, cloudAppAddress } from './app-addresses'
import type { AppAddressTestState, HostAccessState } from './host-access'
import type { HostCloudLinkState } from './host-cloud-link'

/**
 * What stands between a person and the steps that connect an outside app from
 * the phone (plans/035 §10, §0.8). The phone offers only apps that run in the
 * cloud, so the host needs an address that the internet reaches: its Solus
 * tunnel, Tailscale Funnel, or the person's own ingress. The host does not have
 * to be linked to a Solus account. The host then tests that address from
 * outside, as an app would ask it. Only `open` lets the person go on.
 *
 * The phone is never the host machine: it cannot turn the tunnel or Funnel on
 * (both need `host.local.reach`), so the screen says where to do it. A person who
 * may change host settings sets their own address from the phone.
 */
export type OutsideAppGate =
  /** `address`: the host tests the address that the app would use. */
  | { kind: 'checking'; step: 'host' | 'address' }
  /** No address that the internet reaches. `solus` is how far the Solus link got, when the host said. */
  | { kind: 'no-address'; solus: SolusLinkStep | null; hasTailnetAddress: boolean }
  /** The address does not answer from outside. */
  | { kind: 'unreachable'; address: AppAddress; reason: string }
  /** The host cannot be read. */
  | { kind: 'offline'; reason: string }
  | { kind: 'open'; address: AppAddress }

/** How far the host is from a Solus tunnel address. `reason`: why Solus Cloud stopped a link, or why the tunnel is down. */
export type SolusLinkStep =
  | { kind: 'not-registered' }
  | { kind: 'tunnel-off'; reason: string | null }
  | { kind: 'tunnel-offline'; reason: string | null }

export function outsideAppGate(input: {
  access: HostAccessState
  cloudLink: HostCloudLinkState
  addressTest: AppAddressTestState | null
}): OutsideAppGate {
  const { access } = input
  if (access.kind === 'error') return { kind: 'offline', reason: access.message }
  if (access.kind !== 'loaded') return { kind: 'checking', step: 'host' }
  if (access.appEndpointError) return { kind: 'offline', reason: access.appEndpointError }
  const addresses = access.appEndpoint ? appAddressesOf(access.appEndpoint) : []
  const address = cloudAppAddress(addresses)
  if (address === null) {
    return {
      kind: 'no-address',
      solus: solusLinkStep(input.cloudLink),
      hasTailnetAddress: addresses.some((entry) => entry.reach === 'tailnet'),
    }
  }
  // A test of an address the host no longer gives says nothing about this one.
  const test = input.addressTest?.url === address.url ? input.addressTest : null
  if (test === null || test.kind === 'running') return { kind: 'checking', step: 'address' }
  if (test.kind === 'error') return { kind: 'unreachable', address, reason: test.message }
  if (!test.reachable) return { kind: 'unreachable', address, reason: test.reason ?? 'The address did not answer.' }
  return { kind: 'open', address }
}

/** The Solus link is one of three ways; the gate never waits for it. */
function solusLinkStep(cloudLink: HostCloudLinkState): SolusLinkStep | null {
  if (cloudLink.kind !== 'loaded' || cloudLink.status === null) return null
  const { registration, link } = cloudLink.status
  if (!registration.registered) return { kind: 'not-registered' }
  if (!link.linked) return { kind: 'tunnel-off', reason: link.error ?? null }
  if (link.state.observed !== 'online') return { kind: 'tunnel-offline', reason: link.state.error ?? null }
  return null
}

/** The test the gate waits for: the address the app would use, when it has no test yet. */
export function addressToTest(gate: OutsideAppGate, access: HostAccessState): AppAddress | null {
  if (gate.kind !== 'checking' || gate.step !== 'address' || access.kind !== 'loaded' || !access.appEndpoint) return null
  return cloudAppAddress(appAddressesOf(access.appEndpoint))
}

/** The tunnel answers now: the app addresses read before it came online are out of date. */
export function isTunnelOnline(cloudLink: HostCloudLinkState): boolean {
  if (cloudLink.kind !== 'loaded' || !cloudLink.status?.link.linked) return false
  return cloudLink.status.link.state.observed === 'online'
}

/** One way to give the host an address. */
export interface OutsideAppWay {
  label: string
  detail: string
}

/** What the phone says about a gate that is not open. */
export interface OutsideAppGateMessage {
  title: string
  lines: string[]
  ways: OutsideAppWay[]
  /** The person may type their own address here (`publicAddress`, `host.admin`). */
  showsAddressField: boolean
  /** The person can act: on the host, or by asking the host again. */
  canCheckAgain: boolean
}

/**
 * What the phone says about a gate that is not open. The phone cannot change how
 * the host is reached, so it says where to. `appName` is the app the person
 * chose; null when they opened the ways from the host's addresses.
 */
export function outsideAppGateMessage(
  gate: Exclude<OutsideAppGate, { kind: 'open' }>,
  hostName: string,
  options: { appName: string | null; mayChangeHostSettings: boolean },
): OutsideAppGateMessage {
  const none = { ways: [], showsAddressField: false }
  switch (gate.kind) {
    case 'checking':
      return {
        title: gate.step === 'host' ? `Reading the addresses of ${hostName}…` : `Testing the address of ${hostName}…`,
        lines: [],
        ...none,
        canCheckAgain: false,
      }
    case 'no-address': {
      const target = options.appName ?? 'cloud apps'
      return {
        title: options.appName ? `${options.appName} needs an internet address` : 'Cloud apps need an internet address',
        lines: [
          gate.hasTailnetAddress
            ? `${hostName} can only be reached on your devices now. Pick one way to open it to ${target}.`
            : `${hostName} has no address on the internet. Pick one way to open it to ${target}.`,
        ],
        // Funnel first: it needs no account. The phone cannot turn on Funnel or the tunnel.
        ways: [
          {
            label: 'Tailscale Funnel',
            detail: gate.hasTailnetAddress
              ? `Tailscale Serve is on for your devices. Turn on Funnel in Solus on ${hostName}, then check again here.`
              : `Turn on Funnel in Solus on ${hostName}, then check again here.`,
          },
          { label: 'Solus Cloud', detail: solusWayDetail(gate.solus, hostName) },
          {
            label: 'Your own address',
            detail: options.mayChangeHostSettings
              ? 'An https proxy or tunnel you run'
              : `The owner of ${hostName} sets it in the host settings`,
          },
        ],
        showsAddressField: options.mayChangeHostSettings,
        canCheckAgain: true,
      }
    }
    case 'unreachable': {
      const isOwnAddress = gate.address.source === 'custom'
      return {
        title: gate.address.source === 'tailscale-funnel' ? 'Could not verify the Tailscale Funnel address' : `${hostName} does not answer at its address`,
        lines: [
          `${gate.address.url} (${appAddressSourceLabel(gate.address.source)})`,
          gate.reason,
          ...(isOwnAddress && !options.mayChangeHostSettings ? [`The owner of ${hostName} sets this address in the host settings.`] : []),
        ],
        ways: [],
        showsAddressField: isOwnAddress && options.mayChangeHostSettings,
        canCheckAgain: true,
      }
    }
    case 'offline':
      return { title: `${hostName} cannot be read`, lines: [gate.reason], ...none, canCheckAgain: true }
  }
}

function solusWayDetail(step: SolusLinkStep | null, hostName: string): string {
  switch (step?.kind) {
    case undefined:
    case 'not-registered':
      return `Link ${hostName} to your account there`
    case 'tunnel-off':
      return [`On ${hostName}, turn on Reachable from the internet`, step.reason].filter(Boolean).join('. ')
    case 'tunnel-offline':
      return [`${hostName} is linked, but its tunnel is offline`, step.reason].filter(Boolean).join('. ')
  }
}
