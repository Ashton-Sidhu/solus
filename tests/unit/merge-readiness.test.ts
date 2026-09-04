import { describe, expect, test } from 'bun:test'
import type { PrChecksSummary } from '@solus/contracts/checks-types'
import type { PullRequest } from '@solus/contracts/providers'
import {
  mergeReadiness,
  readinessTone,
} from '@solus/workspace-ui/components/pr-review/lib/merge-readiness'

// The rail states merge readiness once, in a headline and a sub-line. These
// assert the rules a reader acts on: a PR that cannot land must never read as
// landable, and the sub-line must never spend its one line repeating something
// another section of the same rail already says.
function detailOf(overrides: Partial<PullRequest>): PullRequest {
  // SAFETY: mergeReadiness reads only the six lifecycle fields set here; the
  // rest of the host's detail payload never reaches it.
  return {
    state: 'open',
    draft: false,
    headSha: 'sha-1',
    baseRef: 'main',
    mergeable: true,
    mergeStateStatus: 'clean',
    ...overrides,
  } as PullRequest
}

function checksOf(state: PrChecksSummary['state'], headSha = 'sha-1'): PrChecksSummary {
  // SAFETY: readiness consults the summary's state and head sha only.
  return { state, headSha } as PrChecksSummary
}

const quiet = { unresolvedCount: 0, openedTime: '2 days ago' }

describe('merge readiness', () => {
  test('a clean, green, fully-resolved PR is the only one that reads as ready', () => {
    const ready = mergeReadiness({
      detail: detailOf({}),
      checks: checksOf('passing'),
      ...quiet,
    })
    expect(ready.key).toBe('ready')
    expect(ready.blocked).toBe(false)
    // The note deliberately says nothing about checks: the Checks section
    // three rows below the card already carries that count, and the headline
    // above it already says the PR is ready.
    expect(ready.note).toBe('Opened 2 days ago')
  })

  test('an unresolved thread holds the PR short of ready without calling it blocked', () => {
    const pending = mergeReadiness({
      detail: detailOf({}),
      checks: checksOf('passing'),
      ...quiet,
      unresolvedCount: 2,
    })
    expect(pending.key).toBe('open')
    expect(pending.blocked).toBe(false)
    expect(pending.note).toBe('2 unresolved threads')
  })

  test('a conflicting PR never also claims to have no conflicts', () => {
    const conflicts = mergeReadiness({
      detail: detailOf({ mergeStateStatus: 'dirty', baseRef: 'release' }),
      checks: checksOf('passing'),
      ...quiet,
    })
    expect(conflicts.key).toBe('conflicts')
    expect(conflicts.headline).toBe('Conflicts with release')
    expect(conflicts.blocked).toBe(true)
    // The old note appended "· no conflicts" to any green check run, so a
    // conflicting PR contradicted its own headline one line down.
    expect(conflicts.note).toBe('Rebase onto release to continue')
  })

  test('failing checks outrank conflicts in the headline, since they are the fixable one', () => {
    const failing = mergeReadiness({
      detail: detailOf({ mergeStateStatus: 'dirty' }),
      checks: checksOf('failing'),
      ...quiet,
    })
    expect(failing.key).toBe('checks')
    expect(failing.headline).toBe('Checks need attention')
    expect(failing.blocked).toBe(true)
    // Not "1 of 3 checks passed" — that is the Checks section's own heading,
    // verbatim. The note spends its one line on the conflict instead, which
    // nothing else in the rail states.
    expect(failing.note).toBe('Rebase onto main to continue')
  })

  test('checks from an older head sha never certify the current one as ready', () => {
    const stale = mergeReadiness({
      detail: detailOf({ headSha: 'sha-2' }),
      checks: checksOf('pending', 'sha-1'),
      ...quiet,
    })
    expect(stale.key).toBe('open')
    expect(stale.note).toBe('Checks are refreshing')
  })

  test('a merged or draft PR is never reported as blocked', () => {
    expect(
      mergeReadiness({ detail: detailOf({ state: 'merged' }), checks: undefined, ...quiet }),
    ).toMatchObject({ key: 'merged', headline: 'Merged into main', blocked: false })
    expect(
      mergeReadiness({ detail: detailOf({ draft: true }), checks: undefined, ...quiet }),
    ).toMatchObject({ key: 'draft', blocked: false })
  })

  test('the card is coloured only when the colour says something the headline does not', () => {
    // WHY: the glyph follows the host palette the list's status dots use, so
    // green means "will land", red means "will not", purple means "did". A
    // pull request still in motion — under review, a draft — stays neutral
    // rather than making the card alternate colours as reviews come in.
    expect(readinessTone('ready')).toBe('positive')
    expect(readinessTone('checks')).toBe('negative')
    expect(readinessTone('conflicts')).toBe('negative')
    expect(readinessTone('closed')).toBe('negative')
    expect(readinessTone('merged')).toBe('review')
    expect(readinessTone('open')).toBe('neutral')
    expect(readinessTone('draft')).toBe('neutral')
  })
})
