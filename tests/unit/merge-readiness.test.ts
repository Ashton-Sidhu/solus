import { describe, expect, test } from 'bun:test'
import type { PrChecksSummary } from '@solus/contracts/checks-types'
import type { PrLifecycleAction, PrMergeMethod, PullRequest } from '@solus/contracts/providers'
import {
  mergeReadiness,
  readinessTone,
} from '@solus/workspace-ui/components/pr-review/lib/merge-readiness'

// The pull request page's status card and the project rail's pull request row
// both read this one table: a headline, a sub-line, and the one move that
// changes the state. These assert the rules a reader acts on — a PR that cannot
// land must never read as landable, the move must be one the viewer can make,
// and the sub-line must never spend its one line repeating the headline.
function detailOf(
  overrides: Partial<PullRequest> & {
    mergeMethods?: PrMergeMethod[]
    viewerActions?: PrLifecycleAction[]
    isFork?: boolean
  } = {},
): PullRequest {
  const {
    mergeMethods = ['merge', 'squash', 'rebase'],
    viewerActions = ['merge', 'close', 'reopen', 'ready', 'draft'],
    isFork = false,
    ...rest
  } = overrides
  // SAFETY: readiness reads the lifecycle, mergeability, capability, permission
  // and head-repository fields set here; the rest of the host's detail payload
  // never reaches it.
  return {
    state: 'open',
    draft: false,
    headSha: 'sha-1',
    baseRef: 'main',
    headRef: 'feature',
    headRepo: { owner: 'acme', repo: 'solus', isFork },
    mergeable: true,
    mergeStateStatus: 'clean',
    capabilities: { actions: ['merge', 'close', 'reopen', 'ready', 'draft'], mergeMethods },
    viewerPermissions: { actions: viewerActions },
    ...rest,
  } as PullRequest
}

function checksOf(state: PrChecksSummary['state'], headSha = 'sha-1'): PrChecksSummary {
  // SAFETY: readiness consults the summary's state and head sha only.
  return { state, headSha } as PrChecksSummary
}

const quiet = { unresolvedCount: 0, approvedReviewCount: 0, openedTime: '2 days ago' }

describe('merge readiness', () => {
  test('a clean, green, fully-resolved PR is the only one that reads as ready, and it merges', () => {
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
    expect(ready.action).toEqual({ kind: 'merge', label: 'Merge pull request', method: 'merge' })
  })

  test('the merge names the method the repository actually allows', () => {
    // A squash-only repository must not offer a merge commit the host rejects.
    expect(
      mergeReadiness({ detail: detailOf({ mergeMethods: ['squash'] }), checks: checksOf('passing'), ...quiet })
        .action,
    ).toEqual({ kind: 'merge', label: 'Squash and merge', method: 'squash' })
  })

  test('ready without permission to merge is a state, not a button', () => {
    const readOnly = mergeReadiness({
      detail: detailOf({ viewerActions: ['close'] }),
      checks: checksOf('passing'),
      ...quiet,
    })
    expect(readOnly.key).toBe('ready')
    expect(readOnly.action).toBeNull()
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
    expect(pending.action).toBeNull()
  })

  test('a conflicting PR never also claims to have no conflicts, and offers the resolver', () => {
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
    expect(conflicts.action).toEqual({ kind: 'resolve-conflicts', label: 'Resolve conflicts with agent' })
  })

  test('a conflict outranks failing checks, and the note names the next blocker', () => {
    // WHY: nothing about a branch can be judged until it merges cleanly — the
    // host itself leads with the conflict. The project rail always put the
    // conflict first; the page now agrees. The note does not repeat the
    // headline: it spends its one line on what is still in the way after that.
    const both = mergeReadiness({
      detail: detailOf({ mergeStateStatus: 'dirty' }),
      checks: checksOf('failing'),
      ...quiet,
    })
    expect(both.key).toBe('conflicts')
    expect(both.headline).toBe('Conflicts with main')
    expect(both.note).toBe('Fix failing checks to continue')
    expect(both.action?.kind).toBe('resolve-conflicts')
  })

  test('checks from an older head sha never certify — or condemn — the current one', () => {
    const stale = mergeReadiness({
      detail: detailOf({ headSha: 'sha-2' }),
      checks: checksOf('pending', 'sha-1'),
      ...quiet,
    })
    expect(stale.key).toBe('open')
    expect(stale.headline).toBe('Checks in progress')
    expect(stale.note).toBe('Checks are refreshing')
    // A failure recorded against the previous head is not this head's failure,
    // which is the same refusal the checks chip makes.
    const staleFailure = mergeReadiness({
      detail: detailOf({ headSha: 'sha-2' }),
      checks: checksOf('failing', 'sha-1'),
      ...quiet,
    })
    expect(staleFailure.key).toBe('open')
    expect(staleFailure.action).toBeNull()
  })

  test('names an out-of-date base branch and offers to bring it in', () => {
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
      action: { kind: 'update-branch', label: 'Update branch with agent' },
    })
  })

  test('failing checks get a fix; pending checks get patience', () => {
    expect(
      mergeReadiness({ detail: detailOf({}), checks: checksOf('failing'), ...quiet }),
    ).toMatchObject({
      key: 'checks',
      headline: 'Checks need attention',
      note: 'Fix failing checks to continue',
      blocked: true,
      action: { kind: 'fix-checks', label: 'Fix failing checks with agent' },
    })
    expect(
      mergeReadiness({ detail: detailOf({}), checks: checksOf('pending'), ...quiet }),
    ).toMatchObject({
      key: 'open',
      headline: 'Checks in progress',
      note: 'Wait for checks to finish',
      blocked: false,
      action: null,
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
      action: { kind: 'fix-checks' },
    })
  })

  test('checks that could not be read never let the PR read as ready', () => {
    // WHY: "no checks" is a fact about the repository; "could not load" is a
    // fact about the network. The card must not certify a merge on the second.
    const unavailable = mergeReadiness({
      detail: detailOf({}),
      checks: undefined,
      checksLoadFailed: true,
      ...quiet,
    })
    expect(unavailable.key).toBe('open')
    expect(unavailable.headline).toBe('Checks unavailable')
    expect(unavailable.action).toBeNull()
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
      action: null,
    })
  })

  test('accepts a mergeable host state that has passing hooks', () => {
    const withHooks = mergeReadiness({
      detail: detailOf({ mergeStateStatus: 'has_hooks' }),
      checks: checksOf('passing'),
      ...quiet,
    })
    expect(withHooks.key).toBe('ready')
    expect(withHooks.action?.kind).toBe('merge')
  })

  test('an unknown or host-blocked merge state never exposes a merge action', () => {
    // WHY: permission to request a merge does not prove that the host can land
    // the current head. Null is still computing; blocked still needs a review
    // or branch-protection requirement satisfied.
    for (const detail of [
      detailOf({ mergeable: null, mergeStateStatus: null }),
      detailOf({ mergeStateStatus: 'blocked' }),
      detailOf({ mergeable: false }),
    ]) {
      const readiness = mergeReadiness({ detail, checks: checksOf('passing'), ...quiet })
      expect(readiness.key).not.toBe('ready')
      expect(readiness.action?.kind).not.toBe('merge')
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

  test('a draft asks to be marked ready, and still says what waits behind that', () => {
    const draft = mergeReadiness({
      detail: detailOf({ draft: true, mergeStateStatus: 'dirty' }),
      checks: undefined,
      ...quiet,
    })
    expect(draft).toMatchObject({
      key: 'draft',
      headline: 'Still a draft',
      note: 'Rebase onto main to continue',
      blocked: true,
      action: { kind: 'mark-ready', label: 'Mark ready for review' },
    })
    // Without the permission there is nothing to offer — not a disabled row.
    expect(
      mergeReadiness({ detail: detailOf({ draft: true, viewerActions: ['close'] }), checks: undefined, ...quiet })
        .action,
    ).toBeNull()
  })

  test('a merged or closed PR is never blocked and has no move left', () => {
    expect(
      mergeReadiness({ detail: detailOf({ state: 'merged' }), checks: undefined, ...quiet }),
    ).toMatchObject({ key: 'merged', headline: 'Merged into main', blocked: false, action: null })
    expect(
      mergeReadiness({ detail: detailOf({ state: 'closed' }), checks: undefined, ...quiet }),
    ).toMatchObject({ key: 'closed', headline: 'Closed', blocked: false, action: null })
  })

  test('agent handoffs are offered only for a head the viewer can update', () => {
    // WHY: the handoff drafts a local fix the reviewer then pushes. A head on a
    // fork, or a viewer with read access only, has nowhere to push it.
    for (const detail of [
      detailOf({ mergeStateStatus: 'dirty', isFork: true }),
      detailOf({ mergeStateStatus: 'behind', viewerActions: [] }),
    ]) {
      const readiness = mergeReadiness({ detail, checks: checksOf('failing'), ...quiet })
      expect(readiness.blocked).toBe(true)
      expect(readiness.action).toBeNull()
    }
    // The author can push their own branch even without merge rights.
    expect(
      mergeReadiness({
        detail: detailOf({ viewerActions: ['close', 'ready', 'draft'] }),
        checks: checksOf('failing'),
        ...quiet,
      }).action?.kind,
    ).toBe('fix-checks')
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
