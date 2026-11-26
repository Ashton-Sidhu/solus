import type { HostKind, UplinkStatus } from '@solus/contracts/uplink'
import type { UplinkControl } from '@solus/client-core/uplink-control'
import type { AppAddress, AppAddressSource } from '@solus/contracts/host-api'
import type { AppAddressTests, AppEndpoint } from '../../../contexts/connections/connections.store.svelte'
import { isHairpinReason, type AppAddressReach } from './app-addresses'
import { outsideAppAddress, type OutsideAppAddressKind } from './outside-apps'

/**
 * What stands between a person and the steps of an open row of "Use Solus
 * from your other apps" (after T3 Code's `resolveMcpGate`). Only `open` lets them go on.
 *
 * The rule (plans/035 §0.8): an app on the host's computer gets the local
 * address, which the host always serves, so it skips every other gate. Any
 * other app needs one of the host's addresses that it reaches: a cloud app an
 * `internet` one, an app on another computer an `internet` or a `tailnet` one.
 * The host does not have to be linked to a Solus account: Tailscale or the
 * person's own ingress gives an address too. Before `open`, the host tests the
 * chosen address from outside.
 */
export type OutsideAppGate =
  /** `testSource`: the address the gate waits to test; null while a read or a test runs. */
  | { kind: 'checking'; testSource: AppAddressSource | null }
  /** The host has no address the app reaches: link it to Solus, use Tailscale, or use the person's own address. */
  | { kind: 'no-address'; reach: AppAddressReach; solus: SolusAddressState }
  /**
   * The host (`where: 'host'`) or the chosen address does not answer. `canGoOn`:
   * the host could not reach its own address from itself (hairpin), which says
   * nothing about the app, so the person may go on with a warning.
   */
  | { kind: 'offline'; where: 'host' | 'address'; address: AppAddress | null; reason: string; canGoOn: boolean }
  /** `address` is null for the local one; `warning` says why the address was not proved to answer. */
  | { kind: 'open'; mcpUrl: string; address: AppAddress | null; warning: string | null }

/** Where the "Link to your Solus account" choice stands. */
export type SolusAddressState =
  /** The host is not registered to a Solus account. */
  | { kind: 'not-registered' }
  /** The host is registered, and its public address is off; `error` is why a link stopped. */
  | { kind: 'turn-on'; turningOn: boolean; error: string | null }
  /** The tunnel is linked and does not serve the address. */
  | { kind: 'down'; reason: string }
  /** The host's link could not be read. */
  | { kind: 'unreadable'; reason: string }

export interface OutsideAppGateInput {
  addressKind: OutsideAppAddressKind
  /** Null until read. */
  endpoint: AppEndpoint | null
  endpointError: string | null
  /** Undefined until read. */
  uplink: UplinkStatus | undefined
  uplinkError: string | null
  /** The host's last test of each of its addresses. */
  addressTests: AppAddressTests
  /** The address the person chose to use although the host could not test it from itself. */
  acceptedUrl: string | null
  /** "Turn on" was pressed and its time limit has not passed. */
  turningOn: boolean
}

export function resolveOutsideAppGate(input: OutsideAppGateInput): OutsideAppGate {
  const { endpoint } = input
  if (input.endpointError !== null) return { kind: 'offline', where: 'host', address: null, reason: input.endpointError, canGoOn: false }
  if (!endpoint) return { kind: 'checking', testSource: null }
  const chosen = outsideAppAddress(input.addressKind, endpoint)
  if (chosen && (!chosen.address || input.addressKind === 'any-or-local')) return { kind: 'open', mcpUrl: chosen.url, address: chosen.address, warning: null }
  if (chosen?.address) return testedAddressGate(chosen.address, input.addressTests[chosen.address.source], input.acceptedUrl)
  return noAddressGate(input.addressKind === 'internet' ? 'internet' : 'internet-or-tailnet', input)
}

/** The host serves the address: open it once the host's own test proves that it answers. */
function testedAddressGate(address: AppAddress, test: AppAddressTests[AppAddressSource], acceptedUrl: string | null): OutsideAppGate {
  if (!test || test.url !== address.url) return { kind: 'checking', testSource: address.source }
  if (test.kind === 'running') return { kind: 'checking', testSource: null }
  if (test.kind === 'error') return { kind: 'offline', where: 'address', address, reason: `The address test could not run: ${test.message}`, canGoOn: false }
  if (test.reachable) return { kind: 'open', mcpUrl: address.url, address, warning: null }
  const reason = test.reason ?? 'The address does not answer.'
  const canGoOn = isHairpinReason(reason)
  if (canGoOn && acceptedUrl === address.url) return { kind: 'open', mcpUrl: address.url, address, warning: reason }
  return { kind: 'offline', where: 'address', address, reason, canGoOn }
}

/** The host serves no address the app reaches: the three ways to give it one, with where its Solus link stands. */
function noAddressGate(reach: AppAddressReach, { uplink, uplinkError, turningOn }: OutsideAppGateInput): OutsideAppGate {
  if (!uplink) {
    if (uplinkError === null) return { kind: 'checking', testSource: null }
    return { kind: 'no-address', reach, solus: { kind: 'unreadable', reason: uplinkError } }
  }
  return { kind: 'no-address', reach, solus: solusAddressState(uplink, turningOn) }
}

/** Where the host's Solus Cloud address stands, for the gate and the Solus Cloud card. */
export function solusAddressState(uplink: UplinkStatus, turningOn: boolean): SolusAddressState {
  if (!uplink.registration.registered) return { kind: 'not-registered' }
  if (!uplink.link.linked) return { kind: 'turn-on', turningOn, error: uplink.link.error ?? null }
  // Linked, and the address is not served yet: the tunnel is starting, or it is down.
  if (turningOn || uplink.link.state.observed === 'online') return { kind: 'turn-on', turningOn: true, error: null }
  return { kind: 'down', reason: uplink.link.state.error ?? 'The Solus Cloud address does not answer.' }
}

/**
 * Where the Solus Cloud address is turned on, for the "turn-on" state:
 * - `here`: this client may call `uplinkLink` (a local owner of a personal host);
 * - `policy`: a policy keeps the tunnel off;
 * - `cloud`: a cloud machine gets its address from Solus Cloud, not from a switch;
 * - `elsewhere`: on the host itself.
 */
export type TurnOnWay = 'here' | 'policy' | 'cloud' | 'elsewhere'

export function turnOnWay(input: { hostKind: HostKind | undefined; control: UplinkControl; mayReachLocally: boolean; locked: boolean }): TurnOnWay {
  if (input.hostKind !== undefined && input.hostKind !== 'personal') return 'cloud'
  if (input.locked) return 'policy'
  return input.control === 'manage' && input.mayReachLocally ? 'here' : 'elsewhere'
}

/**
 * How a host is registered, for the "not-registered" state, as the Solus Cloud
 * section does it: `register` with this client's account, `sign-in` first, or
 * `elsewhere` (open Solus from the Solus Cloud account or the desktop app).
 */
export type RegisterWay = 'register' | 'sign-in' | 'elsewhere'

export function registerWay(input: { control: UplinkControl; accountAvailable: boolean; canLink: boolean }): RegisterWay {
  if (input.control !== 'manage' || !input.accountAvailable) return 'elsewhere'
  return input.canLink ? 'register' : 'sign-in'
}

/** How long "Turn on" waits for the Solus Cloud address before it shows the gate again. */
export const TURN_ON_TIME_LIMIT_MS = 90_000
/** How often it reads the address while it waits. */
export const TURN_ON_POLL_MS = 3_000

/**
 * What the Solus Cloud card of the three ways says, and its one action:
 * `sign-in` ("Sign in and link"; the owner's client then registers the host by
 * itself), `link` (register and turn on), `turn-on`, `check` (read again), or
 * `policy` (a policy keeps it off). `summary` null keeps the card's own line.
 */
export interface SolusCard {
  summary: string | null
  action: 'sign-in' | 'link' | 'turn-on' | 'check' | 'policy' | null
}

export function solusCard(state: SolusAddressState | null, register: RegisterWay, turnOn: TurnOnWay, hostName: string): SolusCard {
  if (!state) return { summary: null, action: null }
  switch (state.kind) {
    case 'not-registered':
      if (register === 'register') return { summary: null, action: 'link' }
      if (register === 'sign-in') return { summary: null, action: 'sign-in' }
      return { summary: `Link it from ${hostName} itself, or from your Solus Cloud account.`, action: 'check' }
    case 'turn-on':
      if (turnOn === 'here') return { summary: state.error, action: 'turn-on' }
      if (turnOn === 'policy') return { summary: null, action: 'policy' }
      if (turnOn === 'cloud') return { summary: `Solus Cloud gives ${hostName} its address while the machine runs.`, action: 'check' }
      return { summary: `Turn it on from ${hostName} itself.`, action: 'check' }
    case 'down':
    case 'unreadable':
      return { summary: state.reason, action: 'check' }
  }
}
