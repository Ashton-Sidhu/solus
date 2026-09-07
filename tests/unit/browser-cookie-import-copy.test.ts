import { describe, expect, test } from 'bun:test'
import type { BrowserCookieSource } from '@solus/contracts/browser-types'
import {
  blockedSourceDetail,
  importSummary,
  sourceDetail,
} from '@solus/workspace-ui/components/browser/lib/profiles'

/**
 * What the cookie import panel says. Every line is the one thing a person needs
 * to decide or do next; a line that misstates the state is a correctness bug in
 * the same way a lying spinner is.
 */

const DAY = 86_400_000

function source(overrides: Partial<BrowserCookieSource>): BrowserCookieSource {
  return { id: 'chrome:Default', label: 'Chrome — Personal', browser: 'chrome', importable: 12, ...overrides }
}

describe('a source row', () => {
  test('says how many cookies would land and when the profile was last used', () => {
    const now = Date.now()
    expect(sourceDetail(source({ lastUsedAt: now - DAY / 2 }), now)).toBe('12 cookies · used today')
    expect(sourceDetail(source({ lastUsedAt: now - DAY }), now)).toBe('12 cookies · used yesterday')
    expect(sourceDetail(source({ lastUsedAt: now - 3 * DAY }), now)).toBe('12 cookies · used 3 days ago')
    expect(sourceDetail(source({ lastUsedAt: now - 45 * DAY }), now)).toBe('12 cookies · not used this month')
    expect(sourceDetail(source({ importable: 1 }))).toBe('1 cookie')
  })

  test('an empty profile says there is nothing to import rather than offering zero', () => {
    // WHY: "0 cookies · used today" reads as a working source with a count. The
    // row is disabled, and the words say why.
    expect(sourceDetail(source({ importable: 0, lastUsedAt: Date.now() }))).toBe('Nothing to import')
  })
})

describe('a blocked source row', () => {
  const blocked = source({ id: 'safari:default', browser: 'safari', label: 'Safari', importable: 0,
    unavailable: 'Needs Full Disk Access.', canRequestAccess: true })

  test('leads with the host’s reason, then with what the user has left to do', () => {
    // WHY: the host has opened the setting; from there the work is the user's.
    // After a re-scan that still finds it blocked, the one remaining cause is a
    // process that has not picked the grant up, and only then is a restart asked for.
    expect(blockedSourceDetail(blocked, 'idle')).toBe('Needs Full Disk Access.')
    expect(blockedSourceDetail(blocked, 'requested')).toBe('Allow Solus in the settings that opened, then check again.')
    expect(blockedSourceDetail(blocked, 'rechecked')).toBe('Still blocked. Restart Solus after allowing it, then check again.')
  })
})

describe('the result', () => {
  const skipped = { expired: 0, partitioned: 0, container: 0, encrypted: 0, unsupported: 0 }

  test('leads with what landed and names every rejection after it', () => {
    expect(importSummary({
      profileId: 'default', read: 9, imported: 4, failed: 1,
      skipped: { ...skipped, expired: 2, encrypted: 1, container: 1 },
    })).toEqual({
      headline: '4 cookies imported',
      detail: 'Skipped 2 expired, 1 in containers, 1 the host could not decrypt, 1 refused by the browser.',
    })
  })

  test('a clean import has no second line, and an empty one says so plainly', () => {
    expect(importSummary({ profileId: 'default', read: 1, imported: 1, failed: 0, skipped }))
      .toEqual({ headline: '1 cookie imported', detail: null })
    expect(importSummary({ profileId: 'default', read: 0, imported: 0, failed: 0, skipped }).headline)
      .toBe('No cookies imported')
  })
})
