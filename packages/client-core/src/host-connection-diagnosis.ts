import type { ConnectionStage, ConnectionStageReport, ConnectionStageResult } from '@solus/contracts/host-connection'
import type { RouteKind } from '@solus/contracts/host-routes'
import type { AddressAnswer, HostConnectionCheck, RouteAnswer } from './host-connection-check'
import type { HostDiagnostics } from './host-diagnostics'
import { hostReadinessCopy } from './host-readiness'

/**
 * Where the connection to a host stopped, from this device
 * (docs/plans/host-readiness.md, Staged diagnosis). Desktop, web, and mobile render
 * this one model. Only evidence makes a stage `ok`: an answer proves the stages it
 * came through, and nothing proves a stage because a later one failed.
 */

const STAGE_ORDER: readonly ConnectionStage[] = ['device', 'cloud', 'tunnel', 'host']
const DIRECT_ROUTE_STAGES: readonly ConnectionStage[] = ['device', 'host']

export interface HostConnectionDiagnosis {
  /** Names the first failed stage, or what is known when no stage failed. */
  headline: string
  stages: ConnectionStageReport[]
  /** Null when no stage failed. */
  failedStage: ConnectionStage | null
  /** What to try, for each failed stage in order. */
  steps: string[]
  /** When the last connection check ran; null when none ran. */
  checkedAt: number | null
  isChecking: boolean
}

/** One thing a check found. Without a stage, it explains a state that no stage can be blamed for. */
interface Finding {
  stage: ConnectionStage | null
  headline: string
  steps: string[]
}

interface StageEvidence {
  result: ConnectionStageResult
  detail: string | null
}

class Evidence {
  private readonly byStage = new Map<ConnectionStage, StageEvidence>()
  readonly findings: Finding[] = []

  ok(stage: ConnectionStage, detail: string | null = null): void {
    if (!this.byStage.has(stage)) this.byStage.set(stage, { result: 'ok', detail })
  }

  /** A failure replaces an `ok`: the answer that proved the stage says less than this one. */
  failed(stage: ConnectionStage, detail: string, finding: Omit<Finding, 'stage'>): void {
    this.byStage.set(stage, { result: 'failed', detail })
    this.findings.push({ stage, ...finding })
  }

  /** Known to be unclear: the stage stays `unknown`, and the detail says why. */
  unknown(stage: ConnectionStage, detail: string): void {
    this.byStage.set(stage, { result: 'unknown', detail })
  }

  of(stage: ConnectionStage): StageEvidence {
    return this.byStage.get(stage) ?? { result: 'unknown', detail: null }
  }
}

function stageLabel(stage: ConnectionStage, host: string): string {
  switch (stage) {
    case 'device': return 'This device'
    case 'cloud': return 'Solus Cloud'
    case 'tunnel': return `${host}'s tunnel`
    case 'host': return `Solus on ${host}`
  }
}

function answerDetail(answer: AddressAnswer): string {
  switch (answer.kind) {
    case 'status': return `HTTP ${answer.status}`
    case 'opaque': return 'Something answered, but this app cannot read the answer'
    case 'no-answer': return 'No answer from this device'
    case 'timeout': return 'No answer in time from this device'
  }
}

/** Something answered, so this device has a network. */
function isAnswer(answer: RouteAnswer): boolean {
  return answer.kind !== 'no-answer' && answer.kind !== 'timeout'
}

function readCloud(evidence: Evidence, answer: AddressAnswer | null): void {
  if (!answer) return
  if (answer.kind === 'opaque' || (answer.kind === 'status' && answer.status < 500)) {
    evidence.ok('device')
    evidence.ok('cloud')
    return
  }
  if (answer.kind === 'status') {
    evidence.ok('device')
    evidence.failed('cloud', answerDetail(answer), {
      headline: 'Solus Cloud returned an error',
      steps: ['Wait a few minutes. Solus keeps trying.', 'If it stays, use Copy details and report it.'],
    })
    return
  }
  evidence.failed('cloud', answerDetail(answer), {
    headline: 'This device cannot reach Solus Cloud',
    steps: [
      'Check the internet connection of this device.',
      'A VPN, firewall, ad blocker, or DNS filter on this device can block Solus Cloud.',
    ],
  })
}

function hostChecks(host: string): string {
  return `On ${host}, run \`solus connect status\`. It names the cause on the host.`
}

function readHostAnswered(evidence: Evidence, host: string): void {
  evidence.ok('host', 'It answers /health')
  evidence.findings.push({
    stage: null,
    headline: `${host} answers, but the connection did not open`,
    steps: [
      'Select Retry now.',
      'A proxy or VPN on this device can block WebSockets.',
      `If the versions below differ, update Solus on ${host}.`,
    ],
  })
}

function readUnproven(evidence: Evidence, host: string): void {
  evidence.failed('host', 'It did not prove that it is this host', {
    headline: `The server at this address did not prove that it is ${host}`,
    steps: ['If this is the machine you mean, pair it again.', 'A captive Wi-Fi page can also answer at an address.'],
  })
}

/** Cloudflare answers for the tunnel, so its status names the stage that failed. */
function readTunnel(evidence: Evidence, answer: RouteAnswer, host: string): void {
  if (isAnswer(answer)) evidence.ok('device')
  switch (answer.kind) {
    case 'host':
      evidence.ok('tunnel')
      readHostAnswered(evidence, host)
      return
    case 'unproven':
      evidence.ok('tunnel')
      readUnproven(evidence, host)
      return
    case 'opaque':
      evidence.unknown('tunnel', 'Something answered, but this app cannot read the answer')
      evidence.unknown('host', 'It did not answer through the tunnel')
      evidence.findings.push({
        stage: null,
        headline: `${host}'s tunnel or Solus on ${host} did not answer`,
        steps: [
          `Make sure ${host} is awake and Solus runs on it.`,
          hostChecks(host),
          'This app cannot read the answer, so it cannot tell which one failed. The Solus mobile app can.',
        ],
      })
      return
    case 'status':
      // Cloudflare answers 530 (error 1033) when the tunnel has no live connector.
      if (answer.status === 530) {
        evidence.failed('tunnel', 'HTTP 530: no live connection from the host', {
          headline: `${host}'s tunnel is offline`,
          steps: [
            `Make sure ${host} is awake and Solus runs on it.`,
            hostChecks(host),
            `A VPN or a Tailscale exit node on ${host} can block the tunnel (port 7844).`,
          ],
        })
        return
      }
      if (answer.status === 502) {
        evidence.ok('tunnel', 'HTTP 502: the tunnel is up')
        evidence.failed('host', 'It did not answer the tunnel', {
          headline: `The tunnel works, but Solus on ${host} did not answer`,
          steps: [`Open or restart Solus on ${host}.`, hostChecks(host)],
        })
        return
      }
      evidence.findings.push({
        stage: null,
        headline: `${host}'s address answered with HTTP ${answer.status}`,
        steps: ['A proxy or firewall on this device can answer in place of the host.', hostChecks(host)],
      })
      return
    case 'no-answer':
    case 'timeout':
      // With Solus Cloud also silent, this device is the likely cause, not the tunnel.
      if (evidence.of('cloud').result === 'failed') {
        evidence.unknown('tunnel', answerDetail(answer))
        return
      }
      evidence.failed('tunnel', answerDetail(answer), {
        headline: `This device cannot reach ${host}'s tunnel`,
        steps: [
          'A VPN, firewall, or DNS filter on this device can block the tunnel.',
          'Try another network, or use a direct address such as a Tailscale address.',
          hostChecks(host),
        ],
      })
  }
}

function routeSteps(host: string, kinds: readonly RouteKind[]): string[] {
  return [
    `Make sure ${host} is awake and Solus runs on it.`,
    ...(kinds.includes('lan') ? [`Make sure this device is on the same network as ${host}.`] : []),
    ...(kinds.includes('tailnet') ? ['Make sure Tailscale is on, on this device and on the host.'] : []),
    ...(kinds.includes('forwarded') ? ['The SSH forward to the host may have stopped. Add the host again.'] : []),
  ]
}

function readDirectRoutes(evidence: Evidence, routes: HostConnectionCheck['routes'], host: string): void {
  if (routes.some((route) => isAnswer(route.answer))) evidence.ok('device')
  if (routes.some((route) => route.answer.kind === 'host')) {
    readHostAnswered(evidence, host)
    return
  }
  if (routes.some((route) => route.answer.kind === 'unproven')) {
    readUnproven(evidence, host)
    return
  }
  const answered = routes.find((route) => isAnswer(route.answer))
  if (answered) {
    evidence.failed('host', `${answered.url} did not answer as Solus`, {
      headline: `Something other than Solus answers at ${host}'s address`,
      steps: [`The port may have changed. On ${host}, run \`solus status\`.`, 'Add the host again with its new address.'],
    })
    return
  }
  if (routes.length === 0) return
  evidence.failed('host', 'No answer from this device', {
    headline: `${host} did not answer at its address`,
    steps: routeSteps(host, routes.map((route) => route.kind)),
  })
}

function readCheck(evidence: Evidence, check: HostConnectionCheck, usesTunnel: boolean, host: string): void {
  if (check.isDeviceOffline) {
    evidence.failed('device', 'This device says that it has no network', {
      headline: 'This device is offline',
      steps: ['Connect this device to the internet. Solus reconnects by itself.'],
    })
    return
  }
  if (usesTunnel) readCloud(evidence, check.cloud)
  const tunnel = usesTunnel ? check.routes.find((route) => route.kind === 'tunnel') : null
  if (tunnel) readTunnel(evidence, tunnel.answer, host)
  else if (!usesTunnel) readDirectRoutes(evidence, check.routes, host)
}

/** What readiness already knows, with no check. Answers whether a check can add to it. */
function readReadiness(evidence: Evidence, diagnostics: HostDiagnostics, usesTunnel: boolean): boolean {
  const { state, label: host, dialedUrl, routes } = diagnostics
  if (state.readiness === 'refused') {
    const copy = hostReadinessCopy(state, host)
    evidence.ok('device')
    if (routes.find((route) => route.url === dialedUrl)?.kind === 'tunnel') evidence.ok('tunnel')
    evidence.failed('host', copy.detail ?? copy.headline, { headline: copy.headline, steps: ['Select Pair again.'] })
    return false
  }
  if (state.readiness === 'unreachable' && state.unreachableReason === 'not-running') {
    const headline = hostReadinessCopy(state, host).headline
    evidence.failed('host', headline, { headline, steps: ['Select Start.'] })
    return false
  }
  if (state.readiness === 'unreachable' && state.unreachableReason === 'no-address') {
    evidence.findings.push({
      stage: null,
      headline: hostReadinessCopy(state, host).headline,
      steps: [usesTunnel ? `On ${host}, run \`solus connect status\`.` : `On ${host}, run \`solus connect\`, or pair this device on the same network.`],
    })
    return false
  }
  return true
}

/**
 * Null for a host that is `ready` or `gone`: nothing is on the way to it. Without a
 * connection check, every stage that readiness cannot name is `unknown`.
 */
export function diagnoseHostConnection(diagnostics: HostDiagnostics): HostConnectionDiagnosis | null {
  const { state, label: host, connectionCheck: check, routes, isCheckingConnection } = diagnostics
  if (state.readiness === 'ready' || state.readiness === 'gone') return null
  const usesTunnel = routes.some((route) => route.kind === 'tunnel')
  const order = usesTunnel ? STAGE_ORDER : DIRECT_ROUTE_STAGES
  const evidence = new Evidence()
  const isOpenQuestion = readReadiness(evidence, diagnostics, usesTunnel)
  if (check && isOpenQuestion) readCheck(evidence, check, usesTunnel, host)

  const staged = evidence.findings.filter((finding) => finding.stage !== null)
    .sort((a, b) => order.indexOf(a.stage!) - order.indexOf(b.stage!))
  const first = staged[0] ?? evidence.findings[0]
  return {
    headline: first?.headline ?? hostReadinessCopy(state, host).headline,
    stages: order.map((stage) => ({ stage, label: stageLabel(stage, host), ...evidence.of(stage) })),
    failedStage: staged[0]?.stage ?? null,
    steps: staged.length > 0 ? staged.flatMap((finding) => finding.steps) : first?.steps ?? [],
    checkedAt: check?.at ?? null,
    isChecking: isCheckingConnection,
  }
}
