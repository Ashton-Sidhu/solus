import { describe, expect, test } from 'bun:test'
import type { HostSelfTest } from '@solus/contracts/host-connection'
import type { UplinkStatus } from '@solus/contracts/uplink'
import type { HostAccessState } from '../../apps/mobile/solus-core/features/settings/host-access'
import type { HostCloudLinkState, HostSelfTestState } from '../../apps/mobile/solus-core/features/settings/host-cloud-link'
import { isTunnelOnline, outsideAppGate, outsideAppGateMessage } from '../../apps/mobile/solus-core/features/settings/outside-app-gate'

// The phone connects only apps that run in the cloud, so the steps open only when
// the host answers at its public address. The phone is never the host machine: it
// cannot turn the tunnel on, so it says where to do it and lets the person check again.

const PUBLIC_URL = 'https://h-box.tunnel.example/mcp'
const REGISTERED: UplinkStatus['registration'] = {
  registered: true,
  owner: null,
  registration: { hostId: 'box', kind: 'personal' } as never,
}
const ONLINE: UplinkStatus['link'] = { linked: true, tunnel: { hostname: 'h-box.tunnel.example', proxiedPort: 4810 }, state: { observed: 'online' } }
const PASSED: HostSelfTest = { checkedAt: 1, reachable: true, summary: 'Other devices can reach this machine.', stages: [], problem: null, facts: [] }

function accessWith(publicUrl: string | null, appEndpointError: string | null = null): HostAccessState {
  return {
    kind: 'loaded',
    info: {} as never,
    endpoints: [], devices: [], pairedDevices: [], pairedDevicesError: null,
    organizations: null, organizationsError: null, pair: null,
    appEndpoint: appEndpointError ? null : { localUrl: 'http://localhost:4810/mcp', publicUrl },
    appEndpointError, appPair: null, busy: null,
  }
}

function linkWith(status: UplinkStatus | null): HostCloudLinkState {
  return { kind: 'loaded', control: 'none', status, busy: false }
}

function gateOf(input: { access?: HostAccessState; cloudLink?: HostCloudLinkState; selfTest?: HostSelfTestState | null }) {
  return outsideAppGate({
    access: input.access ?? accessWith(PUBLIC_URL),
    cloudLink: input.cloudLink ?? linkWith({ registration: REGISTERED, link: ONLINE }),
    selfTest: input.selfTest === undefined ? { kind: 'done', test: PASSED } : input.selfTest,
  })
}

describe('the gate before connecting an outside app from the phone', () => {
  test('a host that answers at its public address opens the steps with that address', () => {
    expect(gateOf({})).toEqual({ kind: 'open', publicUrl: PUBLIC_URL })
  })

  test('while the host is read, the screen says it is checking', () => {
    expect(gateOf({ access: { kind: 'loading' } })).toEqual({ kind: 'checking', step: 'host' })
    expect(gateOf({ cloudLink: { kind: 'idle' } })).toEqual({ kind: 'checking', step: 'host' })
    expect(gateOf({ cloudLink: linkWith(null) })).toEqual({ kind: 'checking', step: 'host' })
  })

  test('a host that is not registered to Solus Cloud has no public address to give', () => {
    expect(gateOf({ cloudLink: linkWith({ registration: { registered: false }, link: { linked: false } }) })).toEqual({ kind: 'not-registered' })
  })

  test('a registered host with its tunnel off asks to turn it on there, with why a link stopped', () => {
    expect(gateOf({ cloudLink: linkWith({ registration: REGISTERED, link: { linked: false } }) })).toEqual({ kind: 'tunnel-off', reason: null })
    expect(gateOf({ cloudLink: linkWith({ registration: REGISTERED, link: { linked: false, error: 'The link expired.' } }) }))
      .toEqual({ kind: 'tunnel-off', reason: 'The link expired.' })
  })

  test('a tunnel that is not online is offline, with the reason the host gives', () => {
    const link: UplinkStatus['link'] = { ...ONLINE, state: { observed: 'error', error: 'cloudflared exited' } }
    expect(gateOf({ cloudLink: linkWith({ registration: REGISTERED, link }) })).toEqual({ kind: 'offline', reason: 'cloudflared exited', fix: null })
  })

  test('with the tunnel online, the host tests its own connection before the steps open', () => {
    expect(gateOf({ selfTest: null })).toEqual({ kind: 'checking', step: 'self-test' })
    expect(gateOf({ selfTest: { kind: 'running' } })).toEqual({ kind: 'checking', step: 'self-test' })
  })

  test('a failed self-test blocks the steps with its reason and fix', () => {
    const problem = { stage: 'tunnel', cause: 'unknown', reason: 'The public address did not answer.', fix: 'Restart Solus on the host.', hint: null } as HostSelfTest['problem']
    expect(gateOf({ selfTest: { kind: 'done', test: { ...PASSED, reachable: false, problem } } }))
      .toEqual({ kind: 'offline', reason: 'The public address did not answer.', fix: 'Restart Solus on the host.' })
    expect(gateOf({ selfTest: { kind: 'done', test: { ...PASSED, reachable: false, summary: 'Not reachable.' } } }))
      .toEqual({ kind: 'offline', reason: 'Not reachable.', fix: null })
    expect(gateOf({ selfTest: { kind: 'error', message: 'This host has no self-test.' } }))
      .toEqual({ kind: 'offline', reason: 'This host has no self-test.', fix: null })
  })

  test('a host that cannot be read, or refuses its address, says why', () => {
    expect(gateOf({ access: { kind: 'error', message: 'This host cannot be reached now.' } }))
      .toEqual({ kind: 'offline', reason: 'This host cannot be reached now.', fix: null })
    expect(gateOf({ cloudLink: { kind: 'error', message: 'refused' } })).toEqual({ kind: 'offline', reason: 'refused', fix: null })
    expect(gateOf({ access: accessWith(null, 'only the host administrator') })).toEqual({ kind: 'offline', reason: 'only the host administrator', fix: null })
  })

  test('an address read before the tunnel came online is not used: the phone reads it again', () => {
    expect(gateOf({ access: accessWith(null) }).kind).toBe('offline')
    expect(isTunnelOnline(linkWith({ registration: REGISTERED, link: ONLINE }))).toBe(true)
    expect(isTunnelOnline(linkWith({ registration: REGISTERED, link: { linked: false } }))).toBe(false)
  })

  test('the phone says where to turn the tunnel on, and offers Check again only where the person can act', () => {
    const off = outsideAppGateMessage({ kind: 'tunnel-off', reason: null }, 'Studio Mac')
    expect(off.title).toBe('Turn on the public address on Studio Mac')
    expect(off.lines.join(' ')).toContain('On Studio Mac, open Solus. In Settings → Account, turn on Reachable from the internet.')
    expect(off.canCheckAgain).toBe(true)
    const offline = outsideAppGateMessage({ kind: 'offline', reason: 'No answer.', fix: 'Restart it.' }, 'Studio Mac')
    expect(offline.lines).toEqual(['No answer.', 'Fix: Restart it.'])
    expect(offline.canCheckAgain).toBe(true)
    expect(outsideAppGateMessage({ kind: 'checking', step: 'host' }, 'Studio Mac').canCheckAgain).toBe(false)
  })
})
