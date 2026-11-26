import { describe, expect, test } from 'bun:test'
import { appEndpointAddresses, claudeMcpAddCommand, copiedMcpAddress, OUTSIDE_APP_ACCESS_LEVELS, DEFAULT_OUTSIDE_APP_ACCESS, outsideAppsKeywords, pairingCodeCountdown } from '@solus/workspace-ui/components/connections/lib/outside-apps'
import { isAppActive, pairedDeviceAppName, pairedDeviceDetail, revocableAppIds, revokeAllAppsQuestion } from '@solus/workspace-ui/components/connections/lib/paired-devices'
import { OUTSIDE_APP_GUIDES } from '@solus/contracts/outside-apps'

// "Use Solus in other apps" (plans/035 §10). What a person would notice going
// wrong: a copied address that does not work where they are, a code that looks
// valid after it expired, an app that reads as a device or as connected when it
// never called, "Revoke all apps" that also cuts off their devices, and a
// palette search for an app that does not find the command.

const LOCAL_ONLY = { localUrl: 'http://localhost:4810/mcp', publicUrl: null }
const WITH_TUNNEL = { localUrl: 'http://localhost:4810/mcp', publicUrl: 'https://box.solus.dev/mcp' }

describe('the MCP address', () => {
  test('a host with no tunnel shows only the address on its own computer', () => {
    expect(appEndpointAddresses(LOCAL_ONLY).map((address) => address.url)).toEqual(['http://localhost:4810/mcp'])
  })

  test('a host with a tunnel also shows the public address', () => {
    expect(appEndpointAddresses(WITH_TUNNEL).map((address) => address.kind)).toEqual(['local', 'public'])
  })

  test('Copy MCP address gives the local address on the host computer, else the public one', () => {
    expect(copiedMcpAddress(WITH_TUNNEL, true)).toBe('http://localhost:4810/mcp')
    expect(copiedMcpAddress(WITH_TUNNEL, false)).toBe('https://box.solus.dev/mcp')
  })

  test('another computer gets no address from a host without a public one, not a localhost it cannot reach', () => {
    expect(copiedMcpAddress(LOCAL_ONLY, false)).toBeNull()
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
