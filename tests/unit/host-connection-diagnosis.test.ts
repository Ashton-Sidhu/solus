import { describe, expect, test } from 'bun:test'
import type { HostDiagnostics } from '@solus/client-core/host-diagnostics'
import { diagnoseHostConnection, hostDiagnosticsText } from '@solus/client-core/host-connection-diagnosis'
import type { AddressAnswer, HostConnectionCheck, RouteAnswer } from '@solus/client-core/host-connection-check'

// A lying status is a correctness bug: a stage is `ok` only with evidence, and a stage
// that cannot be known from this device stays `unknown` (docs/plans/host-readiness.md).

const NOW = Date.UTC(2026, 9, 23, 21, 40)
const TUNNEL_URL = 'https://h-raiders.solus.sh'
const LAN_URL = 'http://192.168.1.20:4000'
const OFFLINE = { readiness: 'unreachable', away: true, unreachableReason: 'no-answer', refusedReason: null, lastSeenAt: NOW - 60_000 } as const

const tunnelHost: HostDiagnostics = {
  hostId: 'raiders',
  label: 'Raiders',
  installationId: 'inst-1',
  state: OFFLINE,
  dialedUrl: TUNNEL_URL,
  routes: [{ kind: 'lan', url: LAN_URL }, { kind: 'tunnel', url: TUNNEL_URL }],
  attempt: 3,
  lastDialError: { message: 'websocket error', code: null, at: NOW - 1000 },
  hostVersion: '0.42.0',
  clientVersion: '0.42.0',
  connectionCheck: null,
  isCheckingConnection: false,
}
const directHost: HostDiagnostics = { ...tunnelHost, dialedUrl: LAN_URL, routes: [{ kind: 'lan', url: LAN_URL }] }

function tunnelCheck(tunnel: RouteAnswer, cloud: AddressAnswer | null = { kind: 'status', status: 200 }): HostConnectionCheck {
  return { at: NOW, isDeviceOffline: false, cloud, routes: [{ kind: 'lan', url: LAN_URL, answer: { kind: 'timeout' } }, { kind: 'tunnel', url: TUNNEL_URL, answer: tunnel }] }
}
const directCheck = (answer: RouteAnswer): HostConnectionCheck => ({ at: NOW, isDeviceOffline: false, cloud: null, routes: [{ kind: 'lan', url: LAN_URL, answer }] })

function resultsOf(diagnostics: HostDiagnostics) {
  return Object.fromEntries(diagnoseHostConnection(diagnostics)!.stages.map((report) => [report.stage, report.result]))
}
const withCheck = (connectionCheck: HostConnectionCheck, base = tunnelHost): HostDiagnostics => ({ ...base, connectionCheck })

describe('host connection diagnosis', () => {
  test('before a check, every stage is unknown and the headline is the readiness', () => {
    // WHY: a failed dial alone cannot name a stage, so it must not name one.
    const diagnosis = diagnoseHostConnection(tunnelHost)!
    expect(diagnosis.stages.map((report) => report.result)).toEqual(['unknown', 'unknown', 'unknown', 'unknown'])
    expect(diagnosis.failedStage).toBeNull()
    expect(diagnosis.headline).toBe('Raiders is offline')
    expect(diagnosis.checkedAt).toBeNull()
  })

  test('a ready or removed host has no diagnosis', () => {
    expect(diagnoseHostConnection({ ...tunnelHost, state: { ...OFFLINE, readiness: 'ready', unreachableReason: null } })).toBeNull()
    expect(diagnoseHostConnection({ ...tunnelHost, state: { ...OFFLINE, readiness: 'gone', unreachableReason: null } })).toBeNull()
  })

  test('a direct-only host has no cloud or tunnel stage', () => {
    expect(diagnoseHostConnection(directHost)!.stages.map((report) => report.stage)).toEqual(['device', 'host'])
  })

  test('a 530 fails the tunnel and leaves the host unknown', () => {
    const diagnosis = diagnoseHostConnection(withCheck(tunnelCheck({ kind: 'status', status: 530 })))!
    expect(resultsOf(withCheck(tunnelCheck({ kind: 'status', status: 530 })))).toEqual({ device: 'ok', cloud: 'ok', tunnel: 'failed', host: 'unknown' })
    expect(diagnosis.failedStage).toBe('tunnel')
    expect(diagnosis.headline).toBe("Raiders's tunnel is offline")
    expect(diagnosis.steps.join(' ')).toContain('solus connect status')
    expect(diagnosis.steps.join(' ')).toContain('port 7844')
  })

  test('a 502 proves the tunnel and fails the host', () => {
    const diagnosis = diagnoseHostConnection(withCheck(tunnelCheck({ kind: 'status', status: 502 })))!
    expect(resultsOf(withCheck(tunnelCheck({ kind: 'status', status: 502 })))).toEqual({ device: 'ok', cloud: 'ok', tunnel: 'ok', host: 'failed' })
    expect(diagnosis.headline).toBe('The tunnel works, but Solus on Raiders did not answer')
  })

  test('an answer a browser cannot read leaves the tunnel and the host unknown', () => {
    // WHY: 530 and 502 look the same through a `no-cors` read. Naming one would be a guess.
    const diagnostics = withCheck(tunnelCheck({ kind: 'opaque' }))
    const diagnosis = diagnoseHostConnection(diagnostics)!
    expect(resultsOf(diagnostics)).toEqual({ device: 'ok', cloud: 'ok', tunnel: 'unknown', host: 'unknown' })
    expect(diagnosis.failedStage).toBeNull()
    expect(diagnosis.steps.join(' ')).toContain('solus connect status')
  })

  test('with Solus Cloud silent too, the tunnel is unknown and the cloud is the first failure', () => {
    // WHY: this device is the likely cause; the tunnel may be fine.
    const diagnostics = withCheck(tunnelCheck({ kind: 'no-answer' }, { kind: 'no-answer' }))
    expect(resultsOf(diagnostics)).toEqual({ device: 'unknown', cloud: 'failed', tunnel: 'unknown', host: 'unknown' })
    expect(diagnoseHostConnection(diagnostics)!.headline).toBe('This device cannot reach Solus Cloud')
  })

  test('with Solus Cloud answering, a silent tunnel address is the failure and the device is proven', () => {
    const diagnostics = withCheck(tunnelCheck({ kind: 'timeout' }))
    expect(resultsOf(diagnostics)).toEqual({ device: 'ok', cloud: 'ok', tunnel: 'failed', host: 'unknown' })
    expect(diagnoseHostConnection(diagnostics)!.headline).toBe("This device cannot reach Raiders's tunnel")
  })

  test('a cloud error does not hide what the tunnel said', () => {
    // WHY: a dial does not need Solus Cloud while a token lives, so the tunnel's answer still counts.
    const diagnostics = withCheck(tunnelCheck({ kind: 'status', status: 530 }, { kind: 'status', status: 503 }))
    const diagnosis = diagnoseHostConnection(diagnostics)!
    expect(resultsOf(diagnostics)).toEqual({ device: 'ok', cloud: 'failed', tunnel: 'failed', host: 'unknown' })
    expect(diagnosis.failedStage).toBe('cloud')
    expect(diagnosis.steps.join(' ')).toContain('Wait a few minutes')
    expect(diagnosis.steps.join(' ')).toContain('awake')
  })

  test('no later failure makes an earlier stage ok', () => {
    // WHY: no cloud is known for this host, and the silence proves nothing about this device.
    const diagnostics = withCheck(tunnelCheck({ kind: 'no-answer' }, null))
    expect(resultsOf(diagnostics)).toEqual({ device: 'unknown', cloud: 'unknown', tunnel: 'failed', host: 'unknown' })
  })

  test('a device that says it is offline ends the diagnosis there', () => {
    const diagnostics = withCheck({ ...tunnelCheck({ kind: 'no-answer' }, { kind: 'no-answer' }), isDeviceOffline: true })
    expect(resultsOf(diagnostics)).toEqual({ device: 'failed', cloud: 'unknown', tunnel: 'unknown', host: 'unknown' })
    expect(diagnoseHostConnection(diagnostics)!.headline).toBe('This device is offline')
  })

  test('a host that answers health but not the socket blames no stage', () => {
    const diagnostics = withCheck(tunnelCheck({ kind: 'host' }))
    const diagnosis = diagnoseHostConnection(diagnostics)!
    expect(resultsOf(diagnostics)).toEqual({ device: 'ok', cloud: 'ok', tunnel: 'ok', host: 'ok' })
    expect(diagnosis.failedStage).toBeNull()
    expect(diagnosis.headline).toBe('Raiders answers, but the connection did not open')
  })

  test('a status that names no stage marks none', () => {
    const diagnostics = withCheck(tunnelCheck({ kind: 'status', status: 403 }))
    expect(resultsOf(diagnostics)).toEqual({ device: 'ok', cloud: 'ok', tunnel: 'unknown', host: 'unknown' })
    expect(diagnoseHostConnection(diagnostics)!.headline).toBe("Raiders's address answered with HTTP 403")
  })

  test('a refused host answered: the host fails and the check cannot change it', () => {
    const refused: HostDiagnostics = { ...tunnelHost, state: { ...OFFLINE, readiness: 'refused', unreachableReason: null, refusedReason: 'auth' } }
    expect(resultsOf(refused)).toEqual({ device: 'ok', cloud: 'unknown', tunnel: 'ok', host: 'failed' })
    expect(diagnoseHostConnection(withCheck(tunnelCheck({ kind: 'no-answer' }), refused))!.headline).toBe('Raiders needs pairing again')
  })

  test('a direct host that does not answer says what to check for its kind of address', () => {
    const diagnostics = withCheck(directCheck({ kind: 'no-answer' }), directHost)
    const diagnosis = diagnoseHostConnection(diagnostics)!
    expect(resultsOf(diagnostics)).toEqual({ device: 'unknown', host: 'failed' })
    expect(diagnosis.headline).toBe('Raiders did not answer at its address')
    expect(diagnosis.steps.join(' ')).toContain('same network')
    expect(diagnosis.steps.join(' ')).not.toContain('Tailscale')
  })

  test('something else on a direct address proves the device and fails the host', () => {
    const diagnostics = withCheck(directCheck({ kind: 'status', status: 404 }), directHost)
    expect(resultsOf(diagnostics)).toEqual({ device: 'ok', host: 'failed' })
  })

  test('an address that does not prove the host is not called the host', () => {
    const diagnostics = withCheck(directCheck({ kind: 'unproven' }), directHost)
    expect(resultsOf(diagnostics)).toEqual({ device: 'ok', host: 'failed' })
    expect(diagnoseHostConnection(diagnostics)!.headline).toBe('The server at this address did not prove that it is Raiders')
  })

  test('the copied text carries the stages and says when no check ran', () => {
    expect(hostDiagnosticsText(tunnelHost, NOW)).toContain('Stages (no check ran):')
    const text = hostDiagnosticsText(withCheck(tunnelCheck({ kind: 'status', status: 530 })), NOW)
    expect(text).toContain('Solus Cloud: OK')
    expect(text).toContain("Raiders's tunnel: Failed (HTTP 530: no live connection from the host)")
    expect(text).toContain('Solus on Raiders: Unknown')
  })
})
