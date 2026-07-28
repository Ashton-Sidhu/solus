import { describe, expect, test } from 'bun:test'
import { resolvePreferredHost } from '../../src/renderer/components/servers/lib/preferred-host'

const studio = {
  id: 'studio',
  label: 'Studio',
  url: 'http://studio.local',
  local: false,
  status: 'online' as const,
}
const repo = 'github.com/solus-sh/solus'

function resolve(overrides: Partial<Parameters<typeof resolvePreferredHost>[0]> = {}) {
  return resolvePreferredHost({
    repoKey: repo,
    hasResolved: false,
    isLocked: false,
    currentServerId: 'local',
    pendingServerId: null,
    preferredServerId: 'studio',
    preferredServer: studio,
    preferredStatus: 'online',
    preferredIdentities: [{ path: '/srv/solus', folderName: 'solus', repoKey: repo }],
    ...overrides,
  })
}

describe('preferred Run on host resolution', () => {
  test('an already-resolved repository is a no-op', () => {
    // WHY: effects re-run as host data settles; a remembered target must not
    // requeue a dispatch after the user has already made this repo’s choice.
    expect(resolve({ hasResolved: true })).toEqual({ done: false })
  })

  test('an explicit pending choice wins over a remembered host', () => {
    // WHY: preference is a default, while the picker is an immediate user
    // decision for this tab and must never be overwritten behind their back.
    expect(resolve({ pendingServerId: 'laptop' })).toEqual({ done: true })
  })

  test('an offline preferred host is not auto-selected', () => {
    // WHY: sending a new session toward a known-offline machine makes the
    // default path feel broken; leave the current local choice intact instead.
    expect(resolve({ preferredStatus: 'offline' })).toEqual({ done: true })
  })

  test('local remains the default when no preferred host matches the repo', () => {
    // WHY: a host can be healthy without containing this checkout. Dispatching
    // then would require an unexpected clone rather than preserving local work.
    expect(resolve({ preferredIdentities: [] })).toEqual({ done: true })
  })
})
