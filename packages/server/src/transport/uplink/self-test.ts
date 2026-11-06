import { connect } from 'net'
import { z } from 'zod'
import type { ConnectionStageReport, ConnectionStageResult, HostSelfTest, HostSelfTestCause, HostSelfTestProblem } from '@solus/contracts/host-connection'
import type { UplinkStatus } from '@solus/contracts/uplink'
import type { FetchLike } from '../../admission/access-tokens'
import type { ConnectorFacts } from './connector'

/**
 * The host tests its own connection (docs/plans/host-readiness.md). It sees what no
 * client can see: the connector, the proxied listener, port 7844, and how its public
 * address answers from here. It cannot test another device's network, so `device` is
 * always `unknown`. Nothing here runs unless a person asks: `solus connect status`
 * or the Access tab.
 */

/**
 * `cloudflared` finds the edge through the SRV record
 * `_v2-origintunneld._tcp.argotunnel.com`, which names these two hosts. QUIC and
 * HTTP/2 both use the port.
 */
const TUNNEL_EDGE_HOSTS = ['region1.v2.argotunnel.com', 'region2.v2.argotunnel.com']
const TUNNEL_EDGE_PORT = 7844
const EDGE_CONNECT_TIMEOUT_MS = 5_000
const ADDRESS_TIMEOUT_MS = 8_000
const LISTENER_TIMEOUT_MS = 3_000
const dnsErrorSchema = z.object({ code: z.enum(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME']) })
/** `fetch` wraps the resolver's error, on Node as its cause. */
const dnsFailureSchema = z.union([dnsErrorSchema, z.object({ cause: dnsErrorSchema })])

const healthSchema = z.object({ installationId: z.string() })

/** What one read of an address gave. `installationId` is set when it answered as a Solus host. */
export type AddressProbe =
  | { kind: 'status'; status: number; installationId: string | null }
  | { kind: 'dns-failed' | 'timeout' | 'network-error' }

/** Everything one test learned. Null means that the step did not run. */
export interface SelfTestFacts {
  installationId: string
  registered: boolean
  /** The public address; null while the host is not linked. */
  hostname: string | null
  /** Why the link or its connector failed, as the host last recorded it. */
  linkError: string | null
  isTunnelTurnedOffByPolicy: boolean
  /** Null on a link with no connector: a provisioned machine is reached directly. */
  connector: ConnectorFacts | null
  listener: { expectedPort: number; boundPort: number; isAnswering: boolean | null } | null
  cloud: AddressProbe | null
  endpoint: AddressProbe | null
  isEdgeReachable: boolean | null
  exitNode: { name: string | null } | null
}

function statusOf(probe: AddressProbe | null): number | null {
  return probe?.kind === 'status' ? probe.status : null
}

function exitNodeHint(exitNode: SelfTestFacts['exitNode']): string | null {
  if (!exitNode) return null
  return `Tailscale exit node${exitNode.name ? ` "${exitNode.name}"` : ''} is on. Traffic to Cloudflare goes through it.`
}

function probeDetail(probe: AddressProbe): string {
  switch (probe.kind) {
    case 'status': return `HTTP ${probe.status}`
    case 'dns-failed': return 'The name does not resolve from this machine'
    case 'timeout': return 'No answer in time'
    case 'network-error': return 'The connection failed'
  }
}

function problem(stage: HostSelfTestProblem['stage'], cause: HostSelfTestCause, reason: string, fix: string, hint: string | null = null): HostSelfTestProblem {
  return { stage, cause, reason, fix, hint }
}

const RESTART_FIX = 'Restart Solus. If it stays, run `solus connect` again.'

/** What this machine alone can say is wrong, before any answer from outside. */
function localProblem({ connector, listener, linkError }: SelfTestFacts): HostSelfTestProblem | null {
  if (listener && listener.boundPort !== listener.expectedPort) {
    return problem('host', 'port-conflict', `Port ${listener.expectedPort} is in use on this machine, so the tunnel cannot reach Solus.`, 'Free the port and restart Solus, or turn the link off and on again.')
  }
  if (connector && !connector.isInstalled) {
    return problem('tunnel', 'cloudflared-missing', 'cloudflared is not installed on this machine.', 'Run `solus connect`. It installs cloudflared.')
  }
  if (connector && !connector.isRunning) {
    return problem('tunnel', 'connector-stopped', linkError ?? 'The tunnel client (cloudflared) is not running.', 'Restart Solus. If it stays down, read the server log with `solus logs`.')
  }
  return null
}

/**
 * The edge test is TCP only. With connections up, a 502 from a working tunnel, or DNS
 * that already fails, a failed TCP test would hide the real cause.
 */
function edgeProblem({ connector, endpoint, isEdgeReachable, exitNode }: SelfTestFacts): HostSelfTestProblem | null {
  if (isEdgeReachable !== false || statusOf(endpoint) === 502 || connector?.readyConnections || endpoint?.kind === 'dns-failed') return null
  return problem(
    'tunnel',
    'edge-blocked',
    `Cloudflare's tunnel port (${TUNNEL_EDGE_PORT}) does not answer from this machine.`,
    exitNode
      ? `Run \`tailscale set --exit-node=\`, or allow outbound TCP and UDP port ${TUNNEL_EDGE_PORT} on that network.`
      : `Allow outbound TCP and UDP port ${TUNNEL_EDGE_PORT}, or turn off the VPN or firewall that blocks it.`,
    exitNodeHint(exitNode) ?? 'A VPN, proxy, or firewall can block this port while normal web traffic still works.',
  )
}

/** What the public address answered, read as a cause. Null when it answered as this host. */
function addressProblem(facts: SelfTestFacts): HostSelfTestProblem | null {
  const { connector, endpoint, hostname, listener, exitNode } = facts
  const status = statusOf(endpoint)
  if (status === 200 && endpoint?.kind === 'status' && endpoint.installationId) {
    return endpoint.installationId === facts.installationId
      ? null
      : problem('host', 'other-host-answered', `Another Solus server answers at ${hostname}.`, 'Turn the link off and on again on this machine.')
  }
  if (status === 502) {
    return listener?.isAnswering === false
      ? problem('host', 'listener-silent', 'The tunnel is up, but the Solus tunnel listener on this machine does not answer.', RESTART_FIX)
      : problem('host', 'origin-unreachable', 'The tunnel is up, but it cannot reach Solus on this machine.', RESTART_FIX)
  }
  if (endpoint?.kind === 'dns-failed') {
    return problem('tunnel', 'dns-failed', `${hostname} does not resolve from this machine.`, 'Check the DNS settings on this machine or its VPN.', exitNodeHint(exitNode))
  }
  if (connector?.readyConnections === 0) {
    return problem('tunnel', 'connector-connecting', 'cloudflared has not connected to Cloudflare yet.', 'Wait a minute. If it stays, check the network and read the server log with `solus logs`.')
  }
  // Cloudflare answers 530 (error 1033) when the tunnel has no live connector.
  if (status === 530) return problem('tunnel', 'no-connector', 'Cloudflare has no live connection from this machine for the tunnel.', RESTART_FIX)
  if (status !== null) return problem('tunnel', 'unexpected-answer', `The address answered with HTTP ${status}.`, RESTART_FIX)
  return problem(
    'tunnel',
    endpoint?.kind === 'timeout' ? 'address-timeout' : 'address-unreachable',
    `${hostname} did not answer from this machine.`,
    'Check the network, VPN, or proxy on this machine.',
    exitNodeHint(exitNode),
  )
}

/** Why the tunnel path fails, in the order that names the real cause. Null when the address answered as this host. */
function tunnelProblem(facts: SelfTestFacts): HostSelfTestProblem | null {
  return localProblem(facts) ?? edgeProblem(facts) ?? addressProblem(facts)
}

function cloudProblem(facts: SelfTestFacts): HostSelfTestProblem | null {
  const { cloud } = facts
  if (!cloud || (cloud.kind === 'status' && cloud.status < 500)) return null
  return {
    stage: 'cloud',
    cause: 'cloud-unreachable',
    reason: `Solus Cloud did not answer from this machine (${probeDetail(cloud)}).`,
    fix: 'Check the internet connection, VPN, and DNS on this machine. If they work, wait a few minutes and test again.',
    hint: null,
  }
}

function tunnelDetail(facts: SelfTestFacts, found: HostSelfTestProblem | null): string | null {
  if (found?.stage === 'tunnel') return found.reason
  const { connector } = facts
  if (!connector) return facts.hostname
  return `${connector.readyConnections} connection${connector.readyConnections === 1 ? '' : 's'}, ${connector.protocol === 'http2' ? 'HTTP/2' : 'protocol chosen by cloudflared'}`
}

/** A problem past the tunnel can still prove it: an answer through it shows that it works. */
function tunnelResult(facts: SelfTestFacts, found: HostSelfTestProblem | null): ConnectionStageResult {
  if (found?.stage === 'tunnel') return 'failed'
  if (facts.hostname === null) return 'unknown'
  if (found === null) return 'ok'
  const status = statusOf(facts.endpoint)
  return status === 200 || status === 502 ? 'ok' : 'unknown'
}

function hostResult(facts: SelfTestFacts, found: HostSelfTestProblem | null): ConnectionStageResult {
  // The server that runs this test answers. Linked, the tunnel also needs its proxied listener.
  return found?.stage === 'host' || facts.listener?.isAnswering === false ? 'failed' : 'ok'
}

/** What the rows under the stages show. */
function shownFacts(facts: SelfTestFacts): HostSelfTest['facts'] {
  const shown: HostSelfTest['facts'] = []
  if (facts.hostname) shown.push({ label: 'Address', value: facts.hostname })
  if (facts.endpoint) shown.push({ label: 'Address answer', value: probeDetail(facts.endpoint) })
  if (facts.connector) shown.push({ label: 'cloudflared', value: !facts.connector.isInstalled ? 'Not installed' : facts.connector.isRunning ? 'Running' : 'Not running' })
  if (facts.isEdgeReachable !== null) {
    shown.push({ label: `Port ${TUNNEL_EDGE_PORT}`, value: `TCP ${facts.isEdgeReachable ? 'open' : 'blocked or timed out'}; UDP not tested` })
  }
  if (facts.exitNode) shown.push({ label: 'Tailscale exit node', value: facts.exitNode.name ?? 'On' })
  return shown
}

/** Turns what one test learned into the answer that every surface shows. */
export function classifySelfTest(facts: SelfTestFacts, checkedAt: number): HostSelfTest {
  const cloud = cloudProblem(facts)
  const isLinked = facts.hostname !== null
  const linkRejected: HostSelfTestProblem | null = !isLinked && facts.linkError
    ? { stage: 'tunnel', cause: 'link-rejected', reason: facts.linkError, fix: 'Run `solus connect` to link this server again.', hint: null }
    : null
  const pathProblem = isLinked ? tunnelProblem(facts) : linkRejected
  const stages: ConnectionStageReport[] = [
    { stage: 'device', label: 'Other devices', result: 'unknown', detail: 'This test runs on the host. It cannot test another device\'s network.' },
    {
      stage: 'cloud',
      label: 'Solus Cloud',
      result: cloud ? 'failed' : facts.cloud ? 'ok' : 'unknown',
      detail: cloud?.reason ?? (facts.registered ? null : 'This server is not registered to an account.'),
    },
    {
      stage: 'tunnel',
      label: 'Tunnel',
      result: tunnelResult(facts, pathProblem),
      detail: isLinked ? tunnelDetail(facts, pathProblem) : linkRejected?.reason ?? 'This server has no tunnel.',
    },
    {
      stage: 'host',
      label: 'Solus on this machine',
      result: hostResult(facts, pathProblem),
      detail: pathProblem?.stage === 'host' ? pathProblem.reason : facts.listener?.isAnswering === false ? 'The tunnel listener did not answer.' : null,
    },
  ]
  const reachable = isLinked ? pathProblem === null : null
  // A failed cloud with a failed tunnel is usually one cause: this machine's network.
  // The first failed stage is the problem, and the tunnel's reason stays beside it.
  const first = cloud ? { ...cloud, hint: pathProblem?.reason ?? null } : pathProblem
  return { checkedAt, reachable, summary: summaryOf(facts, reachable, first), stages, problem: first, facts: shownFacts(facts) }
}

function summaryOf(facts: SelfTestFacts, reachable: boolean | null, first: HostSelfTestProblem | null): string {
  if (reachable === true) {
    return first ? 'Other devices can reach this machine through its tunnel, but it cannot reach Solus Cloud.' : 'Other devices can reach this machine through its tunnel.'
  }
  if (first) return first.reason
  if (facts.isTunnelTurnedOffByPolicy) return 'A policy turns the tunnel off. Clients connect to this machine directly.'
  return 'This machine is not linked. Clients connect to it directly.'
}

/** One read of an address. Never rejects. */
export async function probeAddress(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<AddressProbe> {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    const health = response.ok ? healthSchema.safeParse(await response.json().catch(() => null)) : null
    return { kind: 'status', status: response.status, installationId: health?.success ? health.data.installationId : null }
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return { kind: 'timeout' }
    return { kind: dnsFailureSchema.safeParse(error).success ? 'dns-failed' : 'network-error' }
  }
}

function canOpenTcp(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const finish = (isOpen: boolean) => {
      socket.destroy()
      resolve(isOpen)
    }
    socket.setTimeout(EDGE_CONNECT_TIMEOUT_MS, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

export interface HostSelfTestDeps {
  installationId: () => string
  status: () => UplinkStatus
  /** The link has no connector: a provisioned machine is reached directly. */
  isReachedDirectly: () => boolean
  isTunnelTurnedOffByPolicy: () => boolean
  /** The port the proxied listener is bound to; 0 when the bind failed. */
  boundPort: () => number
  connector: () => ConnectorFacts
  exitNode: () => Promise<{ name: string | null } | null>
  fetchImpl?: FetchLike
  openTcp?: (host: string, port: number) => Promise<boolean>
  now?: () => number
}

/** The proxied listener answers as this host, the way `cloudflared` reaches it. Null when the port is not bound here. */
async function readListener(deps: HostSelfTestDeps, fetchImpl: FetchLike, port: number): Promise<boolean | null> {
  if (deps.boundPort() !== port) return null
  const probe = await probeAddress(fetchImpl, `http://127.0.0.1:${port}/health`, LISTENER_TIMEOUT_MS)
  return probe.kind === 'status' && probe.installationId === deps.installationId()
}

async function readEdge(openTcp: NonNullable<HostSelfTestDeps['openTcp']>): Promise<boolean> {
  return (await Promise.all(TUNNEL_EDGE_HOSTS.map((host) => openTcp(host, TUNNEL_EDGE_PORT)))).some(Boolean)
}

async function gatherFacts(deps: HostSelfTestDeps): Promise<SelfTestFacts> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const { registration, link } = deps.status()
  const tunnel = link.linked ? link.tunnel : null
  const connectorTunnel = deps.isReachedDirectly() ? null : tunnel
  const [cloud, endpoint, isAnswering, isEdgeReachable, exitNode] = await Promise.all([
    registration.registered ? probeAddress(fetchImpl, `${registration.registration.directoryUrl}/.well-known/openid-configuration`, ADDRESS_TIMEOUT_MS) : null,
    tunnel ? probeAddress(fetchImpl, `https://${tunnel.hostname}/health`, ADDRESS_TIMEOUT_MS) : null,
    connectorTunnel ? readListener(deps, fetchImpl, connectorTunnel.proxiedPort) : null,
    connectorTunnel ? readEdge(deps.openTcp ?? canOpenTcp) : null,
    tunnel ? deps.exitNode().catch(() => null) : null,
  ])
  return {
    installationId: deps.installationId(),
    registered: registration.registered,
    hostname: tunnel?.hostname ?? null,
    linkError: (link.linked ? link.state.error : link.error) ?? null,
    isTunnelTurnedOffByPolicy: deps.isTunnelTurnedOffByPolicy(),
    connector: connectorTunnel ? deps.connector() : null,
    listener: connectorTunnel ? { expectedPort: connectorTunnel.proxiedPort, boundPort: deps.boundPort(), isAnswering } : null,
    cloud,
    endpoint,
    isEdgeReachable,
    exitNode,
  }
}

/** One test at a time: a second request gets the answer of the test that is running. */
export function createHostSelfTest(deps: HostSelfTestDeps): () => Promise<HostSelfTest> {
  let running: Promise<HostSelfTest> | null = null
  return () => {
    running ??= gatherFacts(deps)
      .then((facts) => classifySelfTest(facts, (deps.now ?? Date.now)()))
      .finally(() => { running = null })
    return running
  }
}
