import { describe, expect, test } from 'bun:test'
import type { PrChecksSummary } from '@solus/contracts/checks-types'
import type { PrLifecycleAction, PrMergeMethod, PullRequest } from '@solus/contracts/providers'
import { mergeReadiness } from '@solus/workspace-ui/components/pr-review/lib/merge-readiness'
import { prPrimaryAction, prPrimaryMenu } from '@solus/workspace-ui/components/pr-review/lib/pr-primary-action'

// The number in the pull request's header is its one action. It must run the
// move the status card names, with a method the base branch allows, and say
// the state when there is no move — never a stale or contradictory label.
const ALL_ACTIONS: PrLifecycleAction[] = ['merge', 'close', 'reopen', 'ready', 'draft', 'enable-auto-merge', 'disable-auto-merge']

function detailOf(overrides: Partial<PullRequest> & { mergeMethods?: PrMergeMethod[] } = {}): PullRequest {
  const { mergeMethods = ['squash', 'rebase'], ...rest } = overrides
  // SAFETY: the action reads the lifecycle, mergeability, capability, permission,
  // auto-merge and head-repository fields set here; nothing else reaches it.
  return {
    state: 'open',
    draft: false,
    headSha: 'sha-1',
    baseRef: 'main',
    headRef: 'feature',
    headRepo: { owner: 'acme', repo: 'solus', isFork: false },
    mergeable: true,
    mergeStateStatus: 'clean',
    capabilities: { actions: ALL_ACTIONS, mergeMethods },
    viewerPermissions: { actions: ALL_ACTIONS },
    ...rest,
  } as PullRequest
}

function checksOf(state: PrChecksSummary['state']): PrChecksSummary {
  // SAFETY: readiness consults the summary's state, head sha, and optional checks only.
  const optional: PrChecksSummary['optional'] = []
  return { state, headSha: 'sha-1', optional } as PrChecksSummary
}

function actionFor(detail: PullRequest, checks = checksOf('passing'), picked: PrMergeMethod | null = null) {
  const readiness = mergeReadiness({ detail, checks, unresolvedCount: 0, approvedReviewCount: 0 })
  return prPrimaryAction(detail, readiness, picked)
}

describe('pull request primary action', () => {
  test('a ready pull request merges with the first method the host allows', () => {
    const action = actionFor(detailOf())
    expect(action.move).toEqual({ kind: 'merge', label: 'Squash and merge', method: 'squash' })
    expect(action.tone).toBe('primary')
  })

  test('starts on the default method the server names', () => {
    const detail = detailOf()
    detail.capabilities.defaultMergeMethod = 'rebase'
    expect(actionFor(detail).move).toEqual({ kind: 'merge', label: 'Rebase and merge', method: 'rebase' })
  })

  test('auto-merge uses the picked method, never one the branch forbids', () => {
    // WHY: auto-merge used to arm a merge commit on a branch that only takes
    // squash or rebase, so GitHub refused it.
    const waiting = detailOf({ mergeStateStatus: 'blocked' })
    expect(actionFor(waiting, checksOf('pending')).move).toEqual({
      kind: 'enable-auto-merge',
      label: 'Auto-merge (squash)',
      method: 'squash',
    })
    expect(actionFor(waiting, checksOf('pending'), 'rebase').move).toMatchObject({ method: 'rebase' })
    expect(actionFor(waiting, checksOf('pending'), 'merge').move).toMatchObject({ method: 'squash' })
  })

  test('an out-of-date branch is updated on the host', () => {
    expect(actionFor(detailOf({ mergeStateStatus: 'behind' })).move).toEqual({ kind: 'update-branch', label: 'Update branch' })
  })

  test('a conflict is the one move painted as a blocker', () => {
    const action = actionFor(detailOf({ mergeable: false, mergeStateStatus: 'dirty' }))
    expect(action.move?.kind).toBe('resolve-conflicts')
    expect(action.tone).toBe('negative')
  })

  test('with no move the number states where the pull request stands', () => {
    expect(actionFor(detailOf({ state: 'merged' }))).toMatchObject({ move: null, label: 'Merged', tone: 'review' })
    expect(actionFor(detailOf({ state: 'closed' }))).toMatchObject({ move: null, label: 'Closed' })
    const armed = actionFor(
      detailOf({ mergeStateStatus: 'blocked', autoMergeEnabled: true, autoMergeMethod: 'squash' }),
      checksOf('pending'),
    )
    expect(armed).toMatchObject({ move: null, label: 'Auto-merge on (squash)', tone: 'positive' })
  })

  test('the caret offers the other ways to land and the way out of auto-merge', () => {
    const waiting = detailOf({ mergeStateStatus: 'blocked' })
    const offered = actionFor(waiting, checksOf('pending'))
    expect(prPrimaryMenu(waiting, offered)).toMatchObject({
      methods: ['squash', 'rebase'],
      mergeNow: true,
      enableAutoMerge: false,
      disableAutoMerge: false,
      method: 'squash',
    })

    const armedDetail = detailOf({ mergeStateStatus: 'blocked', autoMergeEnabled: true, autoMergeMethod: 'rebase' })
    const armed = actionFor(armedDetail, checksOf('pending'))
    expect(prPrimaryMenu(armedDetail, armed)).toMatchObject({ methods: [], disableAutoMerge: true, method: 'rebase' })
  })
})
