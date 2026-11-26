import type { HostKind, UplinkStatus } from '@solus/contracts/uplink'
import type { UplinkControl } from '@solus/client-core/uplink-control'
import type { AppEndpoint } from '../../../contexts/connections/connections.store.svelte'
import type { SelfTestState } from '../../../contexts/connections/uplink.store.svelte'
import type { OutsideAppGuide } from '@solus/contracts/outside-apps'
import { outsideAppAddress, outsideAppAddressKind, type OutsideAppAddressKind } from './outside-apps'

/**
 * What stands between a person and the steps of "Use Solus in other apps"
 * (after T3 Code's `resolveMcpGate`). Only `open` lets them go on.
 *
 * The rule: an app that needs the public address (a cloud app, or any app when
 * this client is not on the host's computer) waits for the host's public
 * address, and for the host's own test that the address answers. An app on the
 * host's computer gets the local address, which the host always serves, so it
 * skips every public-address gate. A cloud machine is linked at its own address,
 * and it goes through the same gates.
 */
export type OutsideAppGate =
  | { kind: 'checking'; needsSelfTest: boolean }
  /** The host is not registered to a Solus account, so it has no public address. */
  | { kind: 'not-registered' }
  /** The host is registered, and its public address is off; `error` is why a link stopped. */
  | { kind: 'turn-on'; turningOn: boolean; error: string | null }
  /** The host (`where: 'host'`) or its public address does not answer, or the test failed. */
  | { kind: 'offline'; where: 'host' | 'public-address'; reason: string; fix: string | null }
  | { kind: 'open'; mcpUrl: string }

export interface OutsideAppGateInput {
  addressKind: OutsideAppAddressKind
  /** Null until read. */
  endpoint: AppEndpoint | null
  endpointError: string | null
  /** Undefined until read. */
  uplink: UplinkStatus | undefined
  uplinkError: string | null
  selfTest: SelfTestState | undefined
  /** "Turn on" was pressed and its time limit has not passed. */
  turningOn: boolean
}

export function resolveOutsideAppGate(input: OutsideAppGateInput): OutsideAppGate {
  const { endpoint } = input
  if (input.endpointError !== null) return { kind: 'offline', where: 'host', reason: input.endpointError, fix: null }
  if (!endpoint) return { kind: 'checking', needsSelfTest: false }
  if (input.addressKind !== 'public') {
    const mcpUrl = outsideAppAddress(input.addressKind, endpoint)
    if (mcpUrl) return { kind: 'open', mcpUrl }
  }
  return endpoint.publicUrl ? testedAddressGate(endpoint.publicUrl, input.selfTest) : linkGate(input)
}

/** The host serves a public address: open it once the host's own test proves it answers. */
function testedAddressGate(publicUrl: string, selfTest: SelfTestState | undefined): OutsideAppGate {
  if (!selfTest) return { kind: 'checking', needsSelfTest: true }
  if (selfTest.kind === 'running') return { kind: 'checking', needsSelfTest: false }
  if (selfTest.kind === 'error') return { kind: 'offline', where: 'public-address', reason: `The connection test could not run: ${selfTest.message}`, fix: null }
  if (selfTest.test.reachable === true) return { kind: 'open', mcpUrl: publicUrl }
  const problem = selfTest.test.problem
  return { kind: 'offline', where: 'public-address', reason: problem?.reason ?? selfTest.test.summary, fix: problem?.fix ?? null }
}

/** The host serves no public address: why, from its registration and its link. */
function linkGate({ uplink, uplinkError, turningOn }: Pick<OutsideAppGateInput, 'uplink' | 'uplinkError' | 'turningOn'>): OutsideAppGate {
  if (!uplink) return uplinkError !== null ? { kind: 'offline', where: 'host', reason: uplinkError, fix: null } : { kind: 'checking', needsSelfTest: false }
  if (!uplink.registration.registered) return { kind: 'not-registered' }
  if (!uplink.link.linked) return { kind: 'turn-on', turningOn, error: uplink.link.error ?? null }
  // Linked, and the address is not served yet: the tunnel is starting, or it is down.
  if (turningOn || uplink.link.state.observed === 'online') return { kind: 'turn-on', turningOn: true, error: null }
  return { kind: 'offline', where: 'public-address', reason: uplink.link.state.error ?? 'The public address does not answer.', fix: null }
}

/**
 * Where the public address is turned on, for the "turn-on" gate:
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
 * How a host is registered, for the "not-registered" gate, as the Solus Cloud
 * section does it: `register` with this client's account, `sign-in` first, or
 * `elsewhere` (open Solus from the Solus Cloud account or the desktop app).
 */
export type RegisterWay = 'register' | 'sign-in' | 'elsewhere'

export function registerWay(input: { control: UplinkControl; accountAvailable: boolean; canLink: boolean }): RegisterWay {
  if (input.control !== 'manage' || !input.accountAvailable) return 'elsewhere'
  return input.canLink ? 'register' : 'sign-in'
}

/** How long "Turn on" waits for the public address before it shows the gate again. */
export const TURN_ON_TIME_LIMIT_MS = 90_000
/** How often it reads the address while it waits. */
export const TURN_ON_POLL_MS = 3_000

/**
 * The address the gate checks. Before an app is chosen (the App step), it is
 * the address any app on this computer could use, so on the host's computer the
 * person picks an app first and meets a public-address gate only for an app
 * that needs it. `guide`: undefined before a choice, null for "Something else…".
 */
export function gateAddressKind(guide: Pick<OutsideAppGuide, 'needsPublicUrl'> | null | undefined, onHostComputer: boolean): OutsideAppAddressKind {
  if (guide === undefined) return onHostComputer ? 'local' : 'public'
  return outsideAppAddressKind(guide, onHostComputer)
}
