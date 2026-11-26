import type { HostAccessState } from './host-access'
import type { HostCloudLinkState, HostSelfTestState } from './host-cloud-link'

/**
 * What stands between a person and the steps that connect an outside app from
 * the phone (plans/035 §10). The phone offers only apps that run in the cloud,
 * so the host must answer at its public address: registered to Solus Cloud,
 * with its tunnel on and online, and with a passed test of its own connection.
 * Only `open` lets the person go on.
 *
 * The phone is never the host machine, so it cannot turn the tunnel on
 * (`uplinkLink` needs `host.local.reach`). The screen says where to do it.
 */
export type OutsideAppGate =
  /** `self-test`: the host is tunneled and online; its test of its own connection is running. */
  | { kind: 'checking'; step: 'host' | 'self-test' }
  | { kind: 'not-registered' }
  /** `reason`: why Solus Cloud no longer accepts a link the host had. */
  | { kind: 'tunnel-off'; reason: string | null }
  | { kind: 'offline'; reason: string; fix: string | null }
  | { kind: 'open'; publicUrl: string }

export function outsideAppGate(input: {
  access: HostAccessState
  cloudLink: HostCloudLinkState
  selfTest: HostSelfTestState | null
}): OutsideAppGate {
  const { access, cloudLink, selfTest } = input
  if (access.kind === 'error') return { kind: 'offline', reason: access.message, fix: null }
  if (cloudLink.kind === 'error') return { kind: 'offline', reason: cloudLink.message, fix: null }
  if (access.kind !== 'loaded' || cloudLink.kind !== 'loaded' || cloudLink.status === null) return { kind: 'checking', step: 'host' }
  if (access.appEndpointError) return { kind: 'offline', reason: access.appEndpointError, fix: null }
  const { registration, link } = cloudLink.status
  if (!registration.registered) return { kind: 'not-registered' }
  if (!link.linked) return { kind: 'tunnel-off', reason: link.error ?? null }
  if (link.state.observed !== 'online') {
    return { kind: 'offline', reason: link.state.error ?? 'The tunnel of this host is offline.', fix: null }
  }
  // The address is read apart from the tunnel; a tunnel that just came online is in it at the next read.
  const publicUrl = access.appEndpoint?.publicUrl ?? null
  if (publicUrl === null) return { kind: 'offline', reason: 'The host has no public address yet.', fix: null }
  if (selfTest === null || selfTest.kind === 'running') return { kind: 'checking', step: 'self-test' }
  if (selfTest.kind === 'error') return { kind: 'offline', reason: selfTest.message, fix: null }
  const { test } = selfTest
  if (test.problem) return { kind: 'offline', reason: test.problem.reason, fix: test.problem.fix }
  if (test.reachable === false) return { kind: 'offline', reason: test.summary, fix: null }
  return { kind: 'open', publicUrl }
}

/** The tunnel answers now: the host's MCP address read before it came online is out of date. */
export function isTunnelOnline(cloudLink: HostCloudLinkState): boolean {
  if (cloudLink.kind !== 'loaded' || !cloudLink.status?.link.linked) return false
  return cloudLink.status.link.state.observed === 'online'
}

/** What the phone says about a gate that is not open. */
export interface OutsideAppGateMessage {
  title: string
  lines: string[]
  /** The person can act: on the host, or by asking the host again. */
  canCheckAgain: boolean
}

/** What the phone says about a gate that is not open. The phone cannot change the host, so it says where to. */
export function outsideAppGateMessage(gate: Exclude<OutsideAppGate, { kind: 'open' }>, hostName: string): OutsideAppGateMessage {
  const needsAddress = `These apps run in the cloud. They need a public address to reach ${hostName}.`
  switch (gate.kind) {
    case 'checking':
      return { title: `Checking the public address of ${hostName}…`, lines: [], canCheckAgain: false }
    case 'not-registered':
      return {
        title: `Register ${hostName} to Solus Cloud`,
        lines: [needsAddress, `On ${hostName}, sign in to Solus. Signing in registers the host. Then turn on its public address.`],
        canCheckAgain: true,
      }
    case 'tunnel-off':
      return {
        title: `Turn on the public address on ${hostName}`,
        lines: [
          needsAddress,
          `On ${hostName}, open Solus. In Settings → Account, turn on Reachable from the internet. You cannot turn it on from a phone.`,
          'Only apps that you approve can use the address.',
          ...(gate.reason ? [gate.reason] : []),
        ],
        canCheckAgain: true,
      }
    case 'offline':
      return {
        title: `${hostName} cannot be reached from the internet`,
        lines: [gate.reason, ...(gate.fix ? [`Fix: ${gate.fix}`] : [])],
        canCheckAgain: true,
      }
  }
}
