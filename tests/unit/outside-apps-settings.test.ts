import { describe, expect, test } from 'bun:test'
import { claudeMcpAddCommand, copiedMcpAddress, OUTSIDE_APP_ACCESS_LEVELS, DEFAULT_OUTSIDE_APP_ACCESS, outsideAppsKeywords, pairingCodeCountdown } from '@solus/workspace-ui/components/connections/lib/outside-apps'
import { isAppActive, pairedDeviceAppName, pairedDeviceDetail, revocableAppIds, revokeAllAppsQuestion } from '@solus/workspace-ui/components/connections/lib/paired-devices'
import { appAddressRows, appAddressTestText, isHairpinReason, localPortOf, preferredAppAddress, publicAddressProblem, tailscaleWay } from '@solus/workspace-ui/components/connections/lib/app-addresses'
import type { AppAddress, TailscaleServeStatus } from '@solus/contracts/host-api'
import { OUTSIDE_APP_GUIDES } from '@solus/contracts/outside-apps'

// "Use Solus in other apps" (plans/035 §10). What a person would notice going
// wrong: a copied address that does not work where they are, a code that looks
// valid after it expired, an app that reads as a device or as connected when it
// never called, "Revoke all apps" that also cuts off their devices, and a
// palette search for an app that does not find the command.

const SOLUS: AppAddress = { source: 'solus', url: 'https://box.solus.dev/mcp', reach: 'internet' }
const FUNNEL: AppAddress = { source: 'tailscale-funnel', url: 'https://box.tail1.ts.net/mcp', reach: 'internet' }
const SERVE: AppAddress = { source: 'tailscale-serve', url: 'https://box.tail1.ts.net/mcp', reach: 'tailnet' }
const CUSTOM: AppAddress = { source: 'custom', url: 'https://solus.example.com/mcp', reach: 'internet' }
const LOCAL_ONLY = { localUrl: 'http://localhost:4810/mcp', publicUrl: null, addresses: [] }
const WITH_TUNNEL = { localUrl: 'http://localhost:4810/mcp', publicUrl: SOLUS.url, addresses: [SOLUS] }

describe('the MCP address', () => {
  test('a host with no other address shows only the address on its own computer', () => {
    expect(appAddressRows(LOCAL_ONLY).map((row) => row.url)).toEqual(['http://localhost:4810/mcp'])
  })

  test('Sharing & access lists every address with its source and reach, in the order an app takes them', () => {
    const rows = appAddressRows({ localUrl: 'http://localhost:4810/mcp', addresses: [SERVE, CUSTOM, SOLUS] })
    expect(rows.map((row) => [row.label, row.reach])).toEqual([
      ["On the host's computer", 'This computer'],
      ['Solus Cloud', 'Internet'],
      ['Your own address', 'Internet'],
      ['Tailscale Serve', 'Your tailnet'],
    ])
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

  test('counts down to its expiry, and says it works once', () => {
    expect(pairingCodeCountdown(now + 10 * 60_000, now)).toBe('Expires 10:00 · one use')
    expect(pairingCodeCountdown(now + 61_500, now)).toBe('Expires 1:02 · one use')
  })

  test('has no countdown once its time is over, so the dialog says it expired', () => {
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

  test('a named app shows its name; a device, an app on the computer, and an unknown app do not', () => {
    expect(pairedDeviceAppName({ ...device, app: { access: 'read', appId: 'chatgpt' } })).toBe('ChatGPT')
    expect(pairedDeviceAppName(device)).toBeNull()
    expect(pairedDeviceAppName({ ...device, app: { access: 'read', appId: 'local' } })).toBeNull()
    expect(pairedDeviceAppName({ ...device, app: { access: 'read', appId: 'other' } })).toBeNull()
  })
})

describe('connected apps', () => {
  const now = Date.parse('2026-11-20T12:00:00Z')
  const app = { deviceId: 'a1', deviceLabel: 'Claude', pairedAt: now - 86_400_000, lastSeenAt: now - 60_000, revokedAt: null, app: { access: 'write' as const, appId: 'claude' as const } }

  test('an app that has not called since its sign-in is not connected yet', () => {
    const fresh = { ...app, pairedAt: now - 30_000, lastSeenAt: now - 30_000 }
    expect(pairedDeviceDetail(fresh, false, now)).toBe('Read and write access · Not connected yet · paired just now')
    expect(isAppActive(fresh, now)).toBe(false)
  })

  test('the dot is on while the app was used in the last five minutes, and off after', () => {
    expect(isAppActive(app, now)).toBe(true)
    expect(isAppActive({ ...app, lastSeenAt: now - 6 * 60_000 }, now)).toBe(false)
    expect(isAppActive({ ...app, revokedAt: now }, now)).toBe(false)
  })

  test('Revoke all apps ends every app that is not revoked, and no device', () => {
    const device = { deviceId: 'd1', deviceLabel: 'Phone', pairedAt: now, lastSeenAt: now, revokedAt: null }
    const revoked = { ...app, deviceId: 'a2', revokedAt: now }
    expect(revocableAppIds([app, device, revoked, { ...app, deviceId: 'a3' }])).toEqual(['a1', 'a3'])
  })

  test('the confirmation names how many apps lose access, and where', () => {
    expect(revokeAllAppsQuestion(1, 'Studio')).toBe('Revoke the connected app? It loses access to Studio at once, and must sign in again.')
    expect(revokeAllAppsQuestion(3, 'Studio')).toBe('Revoke all 3 connected apps? They lose access to Studio at once, and must sign in again.')
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
})

describe('Use your own address', () => {
  test('takes an https address or nothing', () => {
    expect(publicAddressProblem('')).toBeNull()
    expect(publicAddressProblem('  https://solus.example.com  ')).toBeNull()
    expect(publicAddressProblem('http://solus.example.com')).toContain('https')
    expect(publicAddressProblem('solus.example.com')).toContain('full address')
  })

  test('the hint names the local port the ingress proxies to', () => {
    expect(localPortOf('http://localhost:4810/mcp')).toBe('4810')
    expect(localPortOf('not a url')).toBeNull()
  })
})
