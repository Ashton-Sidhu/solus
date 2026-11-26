import { describe, expect, test } from 'bun:test'
import { appEndpointAddresses, claudeMcpAddCommand, pairingCodeExpiry } from '@solus/workspace-ui/components/connections/lib/outside-apps'
import { pairedDeviceAppName, pairedDeviceDetail } from '@solus/workspace-ui/components/connections/lib/paired-devices'

// "Use Solus in other apps" on a host's Access tab (plans/035 §10). What a person
// would notice going wrong: a command that only works on the host's own computer
// when a public address exists, a cloud-app address shown when there is none, a
// code that looks valid after it expired, and an app that reads as a device.

const LOCAL_ONLY = { localUrl: 'http://localhost:4810/mcp', publicUrl: null }
const WITH_TUNNEL = { localUrl: 'http://localhost:4810/mcp', publicUrl: 'https://box.solus.dev/mcp' }

describe('the MCP address', () => {
  test('a host with no tunnel shows only the address on its own computer', () => {
    expect(appEndpointAddresses(LOCAL_ONLY).map((address) => address.url)).toEqual(['http://localhost:4810/mcp'])
  })

  test('a host with a tunnel also shows the public address', () => {
    expect(appEndpointAddresses(WITH_TUNNEL).map((address) => address.kind)).toEqual(['local', 'public'])
  })

  test('the Claude Code command uses the public address, which works from every computer', () => {
    expect(claudeMcpAddCommand(WITH_TUNNEL)).toBe('claude mcp add --transport http solus https://box.solus.dev/mcp')
    expect(claudeMcpAddCommand(LOCAL_ONLY)).toBe('claude mcp add --transport http solus http://localhost:4810/mcp')
  })
})

describe('the pairing code', () => {
  const now = 1_000_000

  test('counts down to its expiry', () => {
    expect(pairingCodeExpiry(now + 10 * 60_000, now)).toBe('Expires in 10:00')
    expect(pairingCodeExpiry(now + 61_500, now)).toBe('Expires in 1:02')
  })

  test('says it expired once its time is over', () => {
    expect(pairingCodeExpiry(now, now)).toBe('Expired')
    expect(pairingCodeExpiry(now - 1, now)).toBe('Expired')
  })
})

describe('an outside app in the paired devices list', () => {
  const now = Date.parse('2026-11-20T12:00:00Z')
  const device = { deviceId: 'd1', deviceLabel: 'Phone', pairedAt: now - 3 * 86_400_000, lastSeenAt: now - 2 * 3_600_000, revokedAt: null }

  test('names the access it was given', () => {
    expect(pairedDeviceDetail({ ...device, app: { access: 'read', appId: 'local' } }, false, now)).toBe('Read access · Last seen 2h ago · paired 3d ago')
    expect(pairedDeviceDetail({ ...device, app: { access: 'write', appId: 'local' } }, false, now)).toBe('Read and write access · Last seen 2h ago · paired 3d ago')
    expect(pairedDeviceDetail({ ...device, app: { access: 'full', appId: 'local' } }, false, now)).toBe('Full access · Last seen 2h ago · paired 3d ago')
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
