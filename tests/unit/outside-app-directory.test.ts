import { describe, expect, test } from 'bun:test'
import type { AppAddress } from '@solus/contracts/host-api'
import { OUTSIDE_APP_GUIDES } from '@solus/contracts/outside-apps'
import { appReachOf, shortAppAddress } from '../../apps/mobile/solus-core/features/settings/app-addresses'
import type { ConnectedApp } from '../../apps/mobile/solus-core/features/settings/host-access'
import {
  appCodeTimeLeft,
  connectCode,
  connectedAppFacts,
  disconnectQuestion,
  newSignInOf,
  outsideAppDirectory,
} from '../../apps/mobile/solus-core/features/settings/outside-app-directory'

// Sharing & access on the phone lists the cloud apps as one directory. What a
// person would notice going wrong: an app shown as Connect when it is connected
// (or Connected after it was revoked), a Connect that cannot work because the host
// has no internet address, an app connected from a computer that the owner cannot
// see or disconnect here, a code from another access level or from before the sheet
// opened, and a sign-in line that never sees the app arrive.

const NOW = Date.parse('2026-11-20T12:00:00')
const grant = (deviceId: string, appId: ConnectedApp['app']['appId'], extra: Partial<ConnectedApp> = {}): ConnectedApp => ({
  deviceId,
  deviceLabel: deviceId,
  pairedAt: NOW - 8 * 86_400_000,
  lastSeenAt: NOW - 4 * 60_000,
  revokedAt: null,
  app: { access: 'write', appId },
  ...extra,
})
const claudeGuide = OUTSIDE_APP_GUIDES.find((guide) => guide.id === 'claude')!

describe('the directory of outside apps', () => {
  test('lists each cloud app with who makes it, and Connect', () => {
    const rows = outsideAppDirectory({ apps: [], hasInternetAddress: true })
    expect(rows.map((row) => [row.name, row.line, row.status])).toEqual([
      ['Claude', 'Anthropic', 'connect'],
      ['ChatGPT', 'OpenAI', 'connect'],
      ['Grok Bot', 'xAI', 'connect'],
      ['Poke', 'Text messages', 'connect'],
      ['Muse', 'Meta', 'connect'],
      ['Instinct', 'Personal assistant', 'connect'],
    ])
  })

  test('an app with access is Connected, with every one of its grants for Disconnect', () => {
    const rows = outsideAppDirectory({ apps: [grant('c1', 'chatgpt'), grant('c2', 'chatgpt', { lastSeenAt: NOW })], hasInternetAddress: true })
    const chatgpt = rows.find((row) => row.key === 'chatgpt')!
    expect(chatgpt.status).toBe('connected')
    expect(chatgpt.line).toBe('Connected')
    expect(chatgpt.grants.map((app) => app.deviceId)).toEqual(['c2', 'c1'])
  })

  test('with no internet address, each app that is not connected needs one; a connected app stays Connected', () => {
    const rows = outsideAppDirectory({ apps: [grant('c1', 'claude')], hasInternetAddress: false })
    expect(rows.find((row) => row.key === 'claude')!.status).toBe('connected')
    expect(rows.find((row) => row.key === 'poke')!.status).toBe('needs-address')
  })

  test('before the host tells its addresses, or to a person who may not read the grants, every app offers Connect', () => {
    const rows = outsideAppDirectory({ apps: null, hasInternetAddress: null })
    expect(new Set(rows.map((row) => row.status))).toEqual(new Set(['connect']))
  })

  test('an app connected from a computer gets its own row, so the owner can disconnect it here', () => {
    const rows = outsideAppDirectory({ apps: [grant('Cursor', 'cursor'), grant('Claude Code', 'local')], hasInternetAddress: true })
    const others = rows.filter((row) => row.guide === null)
    expect(others.map((row) => [row.name, row.status, row.grants.length])).toEqual([
      ['Cursor', 'connected', 1],
      ['Claude Code', 'connected', 1],
    ])
  })
})

describe('the manage sheet of a connected app', () => {
  test('says when it first signed in, when it was last used, and what it can do', () => {
    expect(connectedAppFacts([grant('c1', 'chatgpt', { pairedAt: Date.parse('2026-11-12T12:00:00') })], NOW)).toEqual([
      { label: 'Connected', value: '12 Nov' },
      { label: 'Last used', value: '4m ago' },
      { label: 'Can', value: 'Read and write' },
    ])
  })

  test('an app that has not come back since its approval was not used yet', () => {
    const fresh = grant('c1', 'chatgpt', { pairedAt: NOW - 60_000, lastSeenAt: NOW - 60_000 })
    expect(connectedAppFacts([fresh], NOW)[1]).toEqual({ label: 'Last used', value: 'Not yet' })
  })

  test('Disconnect says that every sign-in of the app loses access', () => {
    expect(disconnectQuestion('ChatGPT', 1).message).toBe('It loses access to this host at once. ChatGPT must sign in again to use it.')
    expect(disconnectQuestion('ChatGPT', 2).message).toStartWith('Each of its 2 sign-ins loses access')
  })
})

describe('the Connect sheet', () => {
  const code = { code: 'K7QM-4XPD', access: 'write' as const, expiresAt: NOW + 552_000 }

  test('shows the code made since it opened, for the access chosen, with the time left', () => {
    expect(connectCode({ current: code, before: null, access: 'write', isBusy: false, now: NOW })).toEqual({ kind: 'live', code: 'K7QM-4XPD', timeLeft: '9:12 left' })
  })

  test('shows no code from before it opened, for another access, or while a new one is made', () => {
    expect(connectCode({ current: code, before: code, access: 'write', isBusy: false, now: NOW }).kind).toBe('none')
    expect(connectCode({ current: code, before: null, access: 'full', isBusy: false, now: NOW }).kind).toBe('none')
    expect(connectCode({ current: code, before: null, access: 'write', isBusy: true, now: NOW }).kind).toBe('none')
  })

  test('says the code expired once its time is over', () => {
    expect(connectCode({ current: code, before: null, access: 'write', isBusy: false, now: code.expiresAt }).kind).toBe('expired')
    expect(appCodeTimeLeft(NOW + 61_500, NOW)).toBe('1:02 left')
  })

  test('sees the sign-in arrive as a grant the host did not list when the sheet opened, whatever the clocks say', () => {
    const known = new Set(['old'])
    const old = grant('old', 'claude', { pairedAt: NOW + 3_600_000 })
    expect(newSignInOf([old, grant('chatgpt', 'chatgpt')], claudeGuide, known)).toBeNull()
    const fresh = grant('new', 'claude', { pairedAt: NOW - 3_600_000 })
    expect(newSignInOf([old, fresh], claudeGuide, known)).toBe(fresh)
  })
})

describe('where apps reach the host', () => {
  const SOLUS: AppAddress = { source: 'solus', url: 'https://box.solus.dev/mcp', reach: 'internet' }
  const SERVE: AppAddress = { source: 'tailscale-serve', url: 'https://box.tail1.ts.net/mcp', reach: 'tailnet' }

  test('Anywhere is the address a cloud app uses; Your devices is only a tailnet address', () => {
    // An internet address serves your devices too: the tailnet row shows only without one.
    expect(appReachOf([SERVE, SOLUS])).toEqual({ anywhere: SOLUS, devices: null })
    expect(appReachOf([SOLUS])).toEqual({ anywhere: SOLUS, devices: null })
    expect(appReachOf([SERVE])).toEqual({ anywhere: null, devices: SERVE })
  })

  test('a row shows the address without its scheme', () => {
    expect(shortAppAddress(SERVE.url)).toBe('box.tail1.ts.net/mcp')
  })
})
