import { describe, expect, test } from 'bun:test'
import type { PrLifecycleAction, PrMergeMethod, PullRequest } from '@solus/contracts/providers'
import { linkedPrPrimaryAction } from '@solus/workspace-ui/components/project-panel/lib/linked-pr-actions'

// The project rail offers one pull request action, and it runs against the code
// host on a single click. These assert the rule that keeps that safe: the rail
// never offers an action the host would refuse, and never names a merge the
// repository does not allow.
function detailOf(
  overrides: Partial<PullRequest> & {
    mergeMethods?: PrMergeMethod[]
    viewerActions?: PrLifecycleAction[]
  } = {},
): PullRequest {
  const { mergeMethods = ['merge', 'squash', 'rebase'], viewerActions = ['merge', 'close', 'draft', 'ready'], ...rest } = overrides
  // SAFETY: the action model reads only the lifecycle, mergeability, capability,
  // and permission fields set here.
  return {
    state: 'open',
    draft: false,
    mergeable: true,
    mergeStateStatus: 'clean',
    capabilities: { actions: ['merge', 'close', 'draft', 'ready'], mergeMethods },
    viewerPermissions: { actions: viewerActions },
    ...rest,
  } as PullRequest
}

describe('linked pull request primary action', () => {
  test('names the merge the repository actually allows', () => {
    expect(linkedPrPrimaryAction(detailOf())).toEqual({
      kind: 'merge',
      label: 'Merge pull request',
      method: 'merge',
    })
    // A squash-only repository must not offer a merge commit the host rejects.
    expect(linkedPrPrimaryAction(detailOf({ mergeMethods: ['squash'] }))).toEqual({
      kind: 'merge',
      label: 'Squash and merge',
      method: 'squash',
    })
  })

  test('a draft asks to be marked ready instead of showing a merge that cannot run', () => {
    expect(linkedPrPrimaryAction(detailOf({ draft: true })).kind).toBe('ready')
    // Without the permission there is nothing to offer — not a disabled merge.
    expect(linkedPrPrimaryAction(detailOf({ draft: true, viewerActions: ['close'] })).kind).toBe('none')
  })

  test('a conflicting pull request offers the resolver, not a dead merge', () => {
    expect(linkedPrPrimaryAction(detailOf({ mergeStateStatus: 'dirty', mergeable: false }))).toEqual({
      kind: 'resolve-conflicts',
      label: 'Resolve merge conflicts with agent',
    })
  })

  test('an unmergeable pull request reports why rather than inviting the click', () => {
    const blocked = linkedPrPrimaryAction(detailOf({ mergeable: false }))
    expect(blocked.kind).toBe('blocked')
    // Still computing is not the same as no: the row stays live.
    expect(linkedPrPrimaryAction(detailOf({ mergeable: null })).kind).toBe('merge')
  })

  test('offers nothing once the pull request has left the open state or the viewer cannot merge', () => {
    expect(linkedPrPrimaryAction(null).kind).toBe('none')
    expect(linkedPrPrimaryAction(detailOf({ state: 'merged' })).kind).toBe('none')
    expect(linkedPrPrimaryAction(detailOf({ state: 'closed' })).kind).toBe('none')
    expect(linkedPrPrimaryAction(detailOf({ viewerActions: ['close'] })).kind).toBe('none')
    expect(linkedPrPrimaryAction(detailOf({ mergeMethods: [] })).kind).toBe('none')
  })
})
