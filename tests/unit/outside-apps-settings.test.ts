import { describe, expect, test } from 'bun:test'
import { claudeMcpAddCommand, copiedMcpAddress, OUTSIDE_APP_ACCESS_LEVELS, DEFAULT_OUTSIDE_APP_ACCESS, outsideAppsKeywords, pairingCodeCountdown } from '@solus/workspace-ui/components/connections/lib/outside-apps'
import { devicesWithAccess, isPhoneLabel, pairedDeviceDetail, revokeAllAppsQuestion } from '@solus/workspace-ui/components/connections/lib/paired-devices'
import { addressHealth, appAddressTestText, hostAppAddress, isHairpinReason, shownAppAddress, preferredAppAddress, publicAddressProblem, tailscaleCard, tailscaleWay } from '@solus/workspace-ui/components/connections/lib/app-addresses'
import type { AppAddress, TailscaleServeStatus } from '@solus/contracts/host-api'
import { OUTSIDE_APP_GUIDES } from '@solus/contracts/outside-apps'

// "Use Solus from your other apps" (plans/035 §10). What a person would notice
// going wrong: a copied address that does not work where they are, a code that
// looks valid after it expired, an app listed among their devices or as used
// when it never called, an address row that shows the wrong address, and a
// palette search for an app that does not find the command.

const SOLUS: AppAddress = { source: 'solus', url: 'https://box.solus.dev/mcp', reach: 'internet' }
const FUNNEL: AppAddress = { source: 'tailscale-funnel', url: 'https://box.tail1.ts.net/mcp', reach: 'internet' }
const SERVE: AppAddress = { source: 'tailscale-serve', url: 'https://box.tail1.ts.net/mcp', reach: 'tailnet' }
const CUSTOM: AppAddress = { source: 'custom', url: 'https://solus.example.com/mcp', reach: 'internet' }
const LOCAL_ONLY = { localUrl: 'http://localhost:4810/mcp', publicUrl: null, addresses: [] }
const WITH_TUNNEL = { localUrl: 'http://localhost:4810/mcp', publicUrl: SOLUS.url, addresses: [SOLUS] }

describe('the MCP address', () => {
  test('the section shows one address: the internet one, which your devices use too, else the tailnet one', () => {
    // WHY: a cloud app must never be handed the tailnet address, and with Funnel on a separate
    // "Your devices · Not set up yet" row was false. One address, and its line says who it reaches.
    expect(hostAppAddress([])).toEqual({ address: null, isDevicesOnly: false })
    expect(hostAppAddress([SERVE, CUSTOM, SOLUS])).toEqual({ address: SOLUS, isDevicesOnly: false })
    expect(hostAppAddress([FUNNEL])).toEqual({ address: FUNNEL, isDevicesOnly: false })
    expect(hostAppAddress([SERVE])).toEqual({ address: SERVE, isDevicesOnly: true })
    // The page shows an address without its scheme; Copy keeps the whole address.
    expect(shownAppAddress(FUNNEL.url)).toBe('box.tail1.ts.net/mcp')
    expect(shownAppAddress('http://localhost:4810/mcp')).toBe('localhost:4810/mcp')
  })

  test('an address shows how its last test went, and a test of another url says nothing about it', () => {
    expect(addressHealth(undefined, SOLUS.url)).toBe('untested')
    expect(addressHealth({ kind: 'running', url: SOLUS.url }, SOLUS.url)).toBe('untested')
    expect(addressHealth({ kind: 'done', url: SOLUS.url, reachable: true, reason: null, checkedAt: 1 }, SOLUS.url)).toBe('answers')
    expect(addressHealth({ kind: 'done', url: SOLUS.url, reachable: false, reason: 'refused', checkedAt: 1 }, SOLUS.url)).toBe('fails')
    expect(addressHealth({ kind: 'error', url: SOLUS.url, message: 'x' }, SOLUS.url)).toBe('fails')
    expect(addressHealth({ kind: 'done', url: FUNNEL.url, reachable: true, reason: null, checkedAt: 1 }, SOLUS.url)).toBe('untested')
  })

  test('Copy MCP address gives the local address on the host computer, else one another computer reaches', () => {
    expect(copiedMcpAddress(WITH_TUNNEL, true)).toBe('http://localhost:4810/mcp')
    expect(copiedMcpAddress(WITH_TUNNEL, false)).toBe(SOLUS.url)
    expect(copiedMcpAddress({ ...LOCAL_ONLY, addresses: [SERVE] }, false)).toBe(SERVE.url)
  })

  test('another computer gets no address from a host without one, not a localhost it cannot reach', () => {
    expect(copiedMcpAddress(LOCAL_ONLY, false)).toBeNull()
  })

  test('a cloud app never gets the tailnet address; an app on a computer gets it last', () => {
    expect(preferredAppAddress([SERVE], 'internet')).toBeNull()
    expect(preferredAppAddress([SERVE, CUSTOM, FUNNEL], 'internet')).toEqual(FUNNEL)
    expect(preferredAppAddress([SERVE, CUSTOM], 'internet-or-tailnet')).toEqual(CUSTOM)
    expect(preferredAppAddress([SERVE], 'internet-or-tailnet')).toEqual(SERVE)
  })

  test('the toast example adds the copied address to Claude Code', () => {
    expect(claudeMcpAddCommand('https://box.solus.dev/mcp')).toBe('claude mcp add --transport http solus https://box.solus.dev/mcp')
  })
})

describe('the access step', () => {
  test('offers the three levels the host grants, starting at Read and write', () => {
    expect(OUTSIDE_APP_ACCESS_LEVELS.map((level) => level.label)).toEqual(['Read', 'Read and write', 'Full'])
    expect(DEFAULT_OUTSIDE_APP_ACCESS).toBe('write')
  })
})

describe('the palette command', () => {
  test('is found by MCP words and by the name of every app in the catalog', () => {
    const keywords = outsideAppsKeywords()
    for (const word of ['mcp', 'connector', 'another app']) expect(keywords).toContain(word)
    for (const guide of OUTSIDE_APP_GUIDES) expect(keywords).toContain(guide.name.toLowerCase())
  })
})

describe('the pairing code', () => {
  const now = 1_000_000

  test('counts down to its expiry', () => {
    expect(pairingCodeCountdown(now + 10 * 60_000, now)).toBe('10:00 left')
    expect(pairingCodeCountdown(now + 61_500, now)).toBe('1:02 left')
  })

  test('has no countdown once its time is over, so the code card says it expired', () => {
    expect(pairingCodeCountdown(now, now)).toBeNull()
    expect(pairingCodeCountdown(now - 1, now)).toBeNull()
  })
})

describe('an outside app in the paired devices list', () => {
  const now = Date.parse('2026-11-20T12:00:00Z')
  const device = { deviceId: 'd1', deviceLabel: 'Phone', pairedAt: now - 3 * 86_400_000, lastSeenAt: now - 2 * 3_600_000, revokedAt: null }

  test('names the access it was given, and when it last connected', () => {
    expect(pairedDeviceDetail({ ...device, app: { access: 'read', appId: 'local' } }, false, now)).toBe('Read access · Last connected 2h ago · paired 3d ago')
    expect(pairedDeviceDetail({ ...device, app: { access: 'write', appId: 'local' } }, false, now)).toBe('Read and write access · Last connected 2h ago · paired 3d ago')
    expect(pairedDeviceDetail({ ...device, app: { access: 'full', appId: 'local' } }, false, now)).toBe('Full access · Last connected 2h ago · paired 3d ago')
    expect(pairedDeviceDetail({ ...device, app: { access: 'full', appId: 'local' }, revokedAt: now - 60_000 }, false, now)).toBe('Full access · Revoked 1m ago')
  })

  test('a device keeps its line as before', () => {
    expect(pairedDeviceDetail(device, false, now)).toBe('Last seen 2h ago · paired 3d ago')
  })

  test('Devices lists the devices that still have access; apps are in the directory', () => {
    const app = { ...device, deviceId: 'a1', app: { access: 'read' as const, appId: 'chatgpt' as const } }
    const revoked = { ...device, deviceId: 'd2', revokedAt: now }
    expect(devicesWithAccess([device, app, revoked]).map((row) => row.deviceId)).toEqual(['d1'])
  })

  test('a phone or a tablet shows a phone icon, any other device a computer', () => {
    expect(isPhoneLabel('Ashton’s iPhone')).toBe(true)
    expect(isPhoneLabel('Pixel 9')).toBe(true)
    expect(isPhoneLabel('Mac mini')).toBe(false)
  })
})

describe('connected apps', () => {
  const now = Date.parse('2026-11-20T12:00:00Z')
  const app = { deviceId: 'a1', deviceLabel: 'Claude', pairedAt: now - 86_400_000, lastSeenAt: now - 60_000, revokedAt: null, app: { access: 'write' as const, appId: 'claude' as const } }

  test('an app that has not called since its sign-in is not connected yet', () => {
    const fresh = { ...app, pairedAt: now - 30_000, lastSeenAt: now - 30_000 }
    expect(pairedDeviceDetail(fresh, false, now)).toBe('Read and write access · Not connected yet · paired just now')
  })

  test('the confirmation names how many apps lose access, and where', () => {
    expect(revokeAllAppsQuestion(1, 'Studio')).toBe('Disconnect the connected app? It loses access to Studio at once, and must sign in again.')
    expect(revokeAllAppsQuestion(3, 'Studio')).toBe('Disconnect all 3 connected apps? They lose access to Studio at once, and must sign in again.')
  })
})

describe('the result of an address test', () => {
  test('says whether the address answers, and nothing for a result of another url', () => {
    expect(appAddressTestText({ kind: 'done', url: SOLUS.url, reachable: true, reason: null, checkedAt: 1 }, SOLUS.url)).toBe('Answers from outside')
    expect(appAddressTestText({ kind: 'done', url: SOLUS.url, reachable: false, reason: 'TLS failed', checkedAt: 1 }, SOLUS.url)).toBe('TLS failed')
    expect(appAddressTestText({ kind: 'error', url: SOLUS.url, message: 'timeout' }, SOLUS.url)).toBe('The test could not run: timeout')
    expect(appAddressTestText({ kind: 'done', url: 'https://old.example/mcp', reachable: true, reason: null, checkedAt: 1 }, SOLUS.url)).toBeNull()
    expect(appAddressTestText(undefined, SOLUS.url)).toBeNull()
  })

  test('a hairpin failure is told apart from an address that does not answer', () => {
    expect(isHairpinReason('Hairpin NAT: the host cannot reach its own public address')).toBe(true)
    expect(isHairpinReason('The router has no NAT loopback.')).toBe(true)
    expect(isHairpinReason('Connection refused')).toBe(false)
    expect(isHairpinReason(null)).toBe(false)
  })
})

describe('the Tailscale choice', () => {
  const status = (patch: Partial<TailscaleServeStatus>): TailscaleServeStatus => ({ enabled: true, funnel: false, port: 443, state: 'active', url: 'https://box.tail1.ts.net', error: null, ...patch })

  test('offers Serve first when it is off, and Funnel once Serve is on', () => {
    expect(tailscaleWay(status({ enabled: false, state: 'off' }), true)).toBe('turn-on-serve')
    expect(tailscaleWay(status({}), true)).toBe('turn-on-funnel')
    expect(tailscaleWay(status({ funnel: true }), true)).toBe('funnel-on')
  })

  test('only the owner on the host computer changes them here; others see where', () => {
    expect(tailscaleWay(status({ enabled: false, state: 'off' }), false)).toBe('serve-elsewhere')
    expect(tailscaleWay(status({}), false)).toBe('funnel-elsewhere')
  })

  test('waits while Tailscale gives the address, and says when Tailscale does not answer', () => {
    expect(tailscaleWay(status({ state: 'ready' }), true)).toBe('serve-waiting')
    expect(tailscaleWay(null, true)).toBe('unknown')
  })

  test('its card offers Turn on only to a local owner, and for a cloud app also when Serve is on', () => {
    // WHY: Turn on for a cloud app turns on Serve and Funnel in one step; with Serve on, Funnel is still needed.
    expect(tailscaleCard('turn-on-serve', null, 'internet', 'Studio').action).toBe('turn-on')
    expect(tailscaleCard('turn-on-funnel', status({}), 'internet', 'Studio').action).toBe('turn-on')
    expect(tailscaleCard('turn-on-funnel', status({}), 'internet-or-tailnet', 'Studio').action).toBe('check')
    expect(tailscaleCard('serve-elsewhere', null, 'internet', 'Studio')).toEqual({ summary: 'Turn it on from Studio itself.', action: 'check' })
    expect(tailscaleCard('unknown', null, 'internet', 'Studio').summary).toContain('Install Tailscale on Studio')
  })

  test('the card distinguishes a private Serve address from a Funnel address that is ready', () => {
    expect(tailscaleCard('turn-on-funnel', status({}), 'internet', 'Studio').summary)
      .toBe('Tailscale Serve is on for your devices. Turn on Funnel to give cloud apps a public address.')
    expect(tailscaleCard('funnel-elsewhere', status({}), 'internet-or-tailnet', 'Studio').summary)
      .toBe('Tailscale Serve is on for your devices.')
    expect(tailscaleCard('funnel-on', status({ funnel: true, url: null }), 'internet', 'Studio').summary)
      .toBe('Tailscale Funnel is on. Waiting for a public address.')
    expect(tailscaleCard('funnel-on', status({ funnel: true }), 'internet', 'Studio').summary)
      .toBe('Tailscale Funnel is on. A public HTTPS address is available.')
  })
})

describe('Use your own address', () => {
  test('takes an https address or nothing', () => {
    expect(publicAddressProblem('')).toBeNull()
    expect(publicAddressProblem('  https://solus.example.com  ')).toBeNull()
    expect(publicAddressProblem('http://solus.example.com')).toContain('https')
    expect(publicAddressProblem('solus.example.com')).toContain('full address')
  })
})
