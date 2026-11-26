import { describe, expect, test } from 'bun:test'
import type { AppAddress, PairedDevice } from '@solus/contracts/host-api'
import { OUTSIDE_APP_GUIDES } from '@solus/contracts/outside-apps'
import {
  activeGrants,
  appRowState,
  directoryColumns,
  grantFacts,
  guideMatchesSearch,
  hasInternetAddress,
  hasNewGrant,
  matchGrants,
  outsideAppLine,
  type AppGrant,
} from '@solus/workspace-ui/components/connections/lib/outside-apps-directory'

// The directory of "Use Solus from your other apps" on Settings › Sharing &
// access (plans/035 §10). What a person would notice going wrong: a cloud app
// in the column of computer apps, an app they connected that still says
// Connect (or the wrong app says Connected), a cloud app that offers Connect on
// a host the cloud cannot reach, a connected app that looks fine when it cannot
// reach Solus, and a sign-in Solus cannot name that disappears from the page.

const NOW = Date.parse('2026-11-20T12:00:00Z')

function grant(deviceId: string, appId: NonNullable<PairedDevice['app']>['appId'], deviceLabel: string, pairedAt = NOW - 86_400_000): AppGrant {
  return { deviceId, deviceLabel, pairedAt, lastSeenAt: pairedAt, revokedAt: null, app: { access: 'write', appId } }
}

describe('the two columns', () => {
  test('cloud apps are on the left, apps on a computer on the right, in catalog order', () => {
    const { cloud, computer } = directoryColumns()
    expect(cloud.map((guide) => guide.id)).toEqual(['claude', 'chatgpt', 'grok-bot', 'poke', 'muse', 'instinct'])
    expect(computer.map((guide) => guide.id)).toEqual(['cursor', 'claude-code', 'codex', 'openclaw', 'hermes-agent'])
    expect(cloud.every((guide) => guide.needsPublicUrl)).toBe(true)
  })

  test('every app has a short line, and the search finds an app by its name or its line', () => {
    expect(OUTSIDE_APP_GUIDES.every((guide) => outsideAppLine(guide).length > 0)).toBe(true)
    const claudeCode = OUTSIDE_APP_GUIDES.find((guide) => guide.id === 'claude-code')!
    expect(guideMatchesSearch(claudeCode, 'claude')).toBe(true)
    expect(guideMatchesSearch(claudeCode, 'terminal')).toBe(true)
    expect(guideMatchesSearch(claudeCode, 'chatgpt')).toBe(false)
  })
})

describe('which app a sign-in belongs to', () => {
  test('a cloud app and Cursor match by their app id', () => {
    const { byGuide, unmatched } = matchGrants([grant('a', 'chatgpt', 'ChatGPT'), grant('b', 'cursor', 'Cursor')])
    expect(byGuide.get('chatgpt')?.map((g) => g.deviceId)).toEqual(['a'])
    expect(byGuide.get('cursor')?.map((g) => g.deviceId)).toEqual(['b'])
    expect(unmatched).toEqual([])
  })

  test('the apps that share `local` match the guide whose name the label holds', () => {
    // WHY: Claude Code, Codex, OpenClaw, and Hermes all sign in as `local`; a Codex sign-in must not mark Claude Code.
    const { byGuide } = matchGrants([grant('codex', 'local', 'codex-mcp-client'), grant('hermes', 'local', 'Hermes'), grant('claw', 'local', 'OpenClaw MCP')])
    expect(byGuide.get('codex')?.map((g) => g.deviceId)).toEqual(['codex'])
    expect(byGuide.get('hermes-agent')?.map((g) => g.deviceId)).toEqual(['hermes'])
    expect(byGuide.get('openclaw')?.map((g) => g.deviceId)).toEqual(['claw'])
    expect(byGuide.has('claude-code')).toBe(false)
  })

  test('a `local` sign-in with a label Solus does not know goes to the first `local` guide', () => {
    const { byGuide, unmatched } = matchGrants([grant('x', 'local', 'my-script')])
    expect(byGuide.get('claude-code')?.map((g) => g.deviceId)).toEqual(['x'])
    expect(unmatched).toEqual([])
  })

  test('an app Solus cannot name matches no guide, so it is listed under the directory', () => {
    const { byGuide, unmatched } = matchGrants([grant('o', 'other', 'Some MCP client')])
    expect(byGuide.size).toBe(0)
    expect(unmatched.map((g) => g.deviceId)).toEqual(['o'])
  })

  test('several sign-ins of one app are kept, newest first', () => {
    const { byGuide } = matchGrants([grant('old', 'claude', 'Claude', NOW - 3 * 86_400_000), grant('new', 'claude', 'Claude', NOW - 3_600_000)])
    expect(byGuide.get('claude')?.map((g) => g.deviceId)).toEqual(['new', 'old'])
  })

  test('only apps that still have access are grants; devices and revoked apps are not', () => {
    const device: PairedDevice = { deviceId: 'phone', deviceLabel: 'iPhone', pairedAt: NOW, lastSeenAt: NOW, revokedAt: null }
    const revoked: PairedDevice = { ...grant('r', 'claude', 'Claude'), revokedAt: NOW }
    expect(activeGrants([device, revoked, grant('ok', 'poke', 'Poke')]).map((g) => g.deviceId)).toEqual(['ok'])
  })
})

describe('what a row shows', () => {
  const SOLUS: AppAddress = { source: 'solus', url: 'https://h.solus.dev/mcp', reach: 'internet' }
  const SERVE: AppAddress = { source: 'tailscale-serve', url: 'https://box.ts.net/mcp', reach: 'tailnet' }

  test('a host has an internet address only from an internet source; a tailnet one does not count', () => {
    expect(hasInternetAddress(null)).toBeNull()
    expect(hasInternetAddress({ addresses: [SERVE] })).toBe(false)
    expect(hasInternetAddress({ addresses: [SERVE, SOLUS] })).toBe(true)
  })

  test('Connect, or Connected once the app signed in', () => {
    expect(appRowState({ needsPublicUrl: true, hasGrant: false, hasInternetAddress: true, isDenied: false })).toBe('connect')
    expect(appRowState({ needsPublicUrl: true, hasGrant: true, hasInternetAddress: true, isDenied: false })).toBe('connected')
    expect(appRowState({ needsPublicUrl: false, hasGrant: true, hasInternetAddress: false, isDenied: false })).toBe('connected')
  })

  test('a cloud app needs an address on a host the internet cannot reach, and a connected one cannot reach Solus', () => {
    expect(appRowState({ needsPublicUrl: true, hasGrant: false, hasInternetAddress: false, isDenied: false })).toBe('needs-address')
    expect(appRowState({ needsPublicUrl: true, hasGrant: true, hasInternetAddress: false, isDenied: false })).toBe('cant-reach')
  })

  test('an app on a computer does not need an internet address, and nothing is said before the addresses are read', () => {
    expect(appRowState({ needsPublicUrl: false, hasGrant: false, hasInternetAddress: false, isDenied: false })).toBe('connect')
    expect(appRowState({ needsPublicUrl: true, hasGrant: false, hasInternetAddress: null, isDenied: false })).toBe('connect')
  })

  test('an app the organization does not allow is marked, unless it already signed in', () => {
    expect(appRowState({ needsPublicUrl: true, hasGrant: false, hasInternetAddress: true, isDenied: true })).toBe('not-allowed')
    expect(appRowState({ needsPublicUrl: true, hasGrant: true, hasInternetAddress: true, isDenied: true })).toBe('connected')
  })
})

describe('a connected app', () => {
  test('its facts say when it was last used, or that it was not used yet, and its access', () => {
    const unused = grant('a', 'claude', 'Claude', NOW - 86_400_000)
    expect(grantFacts(unused, NOW)).toMatchObject({ lastUsed: 'Not used yet', access: 'Read and write' })
    const used = { ...unused, lastSeenAt: NOW - 4 * 60_000 }
    expect(grantFacts(used, NOW).lastUsed).toBe('4m ago')
    expect(grantFacts(used, NOW).connected.length).toBeGreaterThan(0)
  })

  test('the open row sees the app sign in when a sign-in it did not know comes', () => {
    const before = new Set(['a'])
    expect(hasNewGrant(before, [grant('a', 'claude', 'Claude')])).toBe(false)
    expect(hasNewGrant(before, [grant('a', 'claude', 'Claude'), grant('b', 'claude', 'Claude')])).toBe(true)
  })
})
