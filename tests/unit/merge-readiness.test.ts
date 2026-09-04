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

const quiet = { unresolvedCount: 0, approvedReviewCount: 0, openedTime: '2 days ago' }

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

  test('names an out-of-date base branch and tells the user how to continue', () => {
    const behind = mergeReadiness({
      detail: detailOf({ mergeStateStatus: 'behind', baseRef: 'release' }),
      checks: checksOf('passing'),
      ...quiet,
    })
    expect(behind).toMatchObject({
      key: 'behind',
      headline: 'Branch is out of date',
      note: 'Update this branch with release',
      blocked: true,
    })
  })

  test('names failing and pending checks instead of using a generic review state', () => {
    expect(
      mergeReadiness({ detail: detailOf({}), checks: checksOf('failing'), ...quiet }),
    ).toMatchObject({
      key: 'checks',
      headline: 'Checks need attention',
      note: 'Fix failing checks to continue',
      blocked: true,
    })
    expect(
      mergeReadiness({ detail: detailOf({}), checks: checksOf('pending'), ...quiet }),
    ).toMatchObject({
      key: 'open',
      headline: 'Checks in progress',
      note: 'Wait for checks to finish',
      blocked: false,
    })
  })

  test('uses the host status when check details have not exposed the failure', () => {
    const unstable = mergeReadiness({
      detail: detailOf({ mergeStateStatus: 'unstable' }),
      checks: checksOf('passing'),
      ...quiet,
    })
    expect(unstable).toMatchObject({
      key: 'checks',
      headline: 'Checks need attention',
      note: 'Fix failing checks to continue',
      blocked: true,
    })
  })

  test('explains when GitHub is still calculating merge readiness', () => {
    const pending = mergeReadiness({
      detail: detailOf({ mergeable: null, mergeStateStatus: null }),
      checks: checksOf('passing'),
      ...quiet,
    })
    expect(pending).toMatchObject({
      key: 'open',
      headline: 'Merge status pending',
      note: 'GitHub is calculating merge readiness',
      blocked: false,
    })
  })

  test('accepts a mergeable host state that has passing hooks', () => {
    const withHooks = mergeReadiness({
      detail: detailOf({ mergeStateStatus: 'has_hooks' }),
      checks: checksOf('passing'),
      ...quiet,
    })
    expect(withHooks.key).toBe('ready')
  })

  test('an unknown or host-blocked merge state never exposes a ready action', () => {
    // WHY: permission to request a merge does not prove that the host can land
    // the current head. Null is still computing; blocked still needs a review
    // or branch-protection requirement satisfied.
    for (const detail of [
      detailOf({ mergeable: null, mergeStateStatus: null }),
      detailOf({ mergeStateStatus: 'blocked' }),
    ]) {
      expect(
        mergeReadiness({ detail, checks: checksOf('passing'), ...quiet }).key,
      ).toBe('open')
    }
  })

  test('states the remaining approving review requirement', () => {
    const waiting = mergeReadiness({
      detail: detailOf({
        mergeStateStatus: 'blocked',
        requiredApprovingReviewCount: 2,
      }),
      checks: checksOf('passing'),
      ...quiet,
      approvedReviewCount: 1,
    })
    expect(waiting.key).toBe('open')
    expect(waiting.note).toBe('1 approving review required')

    const approved = mergeReadiness({
      detail: detailOf({ requiredApprovingReviewCount: 2 }),
      checks: checksOf('passing'),
      ...quiet,
      approvedReviewCount: 2,
    })
    expect(approved.key).toBe('ready')
  })

  test('explains a host blocker when no numeric approval reason is available', () => {
    const blocked = mergeReadiness({
      detail: detailOf({ mergeStateStatus: 'blocked' }),
      checks: checksOf('passing'),
      ...quiet,
    })
    expect(blocked.note).toBe('Merge requirements are still pending')
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
    expect(readinessTone('behind')).toBe('negative')
    expect(readinessTone('closed')).toBe('negative')
    expect(readinessTone('merged')).toBe('review')
    expect(readinessTone('open')).toBe('neutral')
    expect(readinessTone('draft')).toBe('neutral')
  })
})
