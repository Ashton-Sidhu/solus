import { describe, expect, test } from 'bun:test'
import type { PrLifecycleAction, PrStack, PrStackLayer, PullRequest } from '@solus/contracts/providers'
import {
  stackExpectedHeads,
  stackMergeOutcome,
  stackMergePlan,
} from '@solus/workspace-ui/components/pr-review/lib/pr-stack'
import {
  mayApproveWorkflowRuns,
  readsPendingWorkflowRuns,
} from '@solus/workspace-ui/components/pr-review/lib/workflow-approval'

// "Merge stack" lands every open layer from the bottom up to the pull request
// it is asked on, and the host refuses it when any of those heads moved. So the
// plan must name exactly those layers, in that order, with the heads the reader
// saw, and must not be offered unless the host and the viewer both allow it.

function layer(number: number, overrides: Partial<PrStackLayer> = {}): PrStackLayer {
  return { number, title: `Layer ${number}`, headRef: `layer-${number}`, headSha: `sha-${number}`, state: 'open', draft: false, ...overrides }
}

function stackOf(layers: PrStackLayer[]): PrStack {
  return { number: 7, url: 'https://github.com/acme/solus/stacks/7', base: 'main', layers }
}

function detailOf(
  overrides: Partial<PullRequest> & { hostActions?: PrLifecycleAction[]; viewerActions?: PrLifecycleAction[]; isFork?: boolean } = {},
): PullRequest {
  const { hostActions = ['merge', 'merge-stack', 'approve-workflows'], viewerActions = ['merge', 'merge-stack', 'approve-workflows'], isFork = false, ...rest } = overrides
  // SAFETY: the plan and the approval reads use the number, state, stack,
  // head repository, capability and permission fields set here only.
  return {
    number: 3,
    state: 'open',
    draft: false,
    headSha: 'sha-3',
    headRepo: { owner: 'acme', repo: 'solus', isFork },
    stack: { number: 7, position: 3, size: 4, base: 'main' },
    capabilities: { actions: hostActions, mergeMethods: ['squash', 'merge'], defaultMergeMethod: 'squash' },
    viewerPermissions: { actions: viewerActions },
    ...rest,
  } as PullRequest
}

describe('stack merge plan', () => {
  test('lands the open layers from the bottom up to this one, with the heads the reader saw', () => {
    const stack = stackOf([layer(1, { state: 'merged' }), layer(2), layer(3), layer(4)])
    const plan = stackMergePlan(detailOf(), stack)
    expect(plan?.layers.map((entry) => entry.number)).toEqual([2, 3])
    expect(plan?.expectedHeads).toEqual([
      { number: 2, headSha: 'sha-2' },
      { number: 3, headSha: 'sha-3' },
    ])
    expect(plan?.stackNumber).toBe(7)
    // Every layer lands with the method the merge button starts on.
    expect(plan?.method).toBe('squash')
  })

  test('is not offered unless both the host and the viewer allow it', () => {
    const stack = stackOf([layer(1), layer(2), layer(3)])
    expect(stackMergePlan(detailOf({ hostActions: ['merge'] }), stack)).toBeNull()
    expect(stackMergePlan(detailOf({ viewerActions: ['merge'] }), stack)).toBeNull()
  })

  test('is not offered outside a stack, for a closed pull request, or one the stack no longer lists', () => {
    const stack = stackOf([layer(1), layer(2), layer(3)])
    expect(stackMergePlan(detailOf({ stack: null }), stack)).toBeNull()
    expect(stackMergePlan(detailOf(), null)).toBeNull()
    expect(stackMergePlan(detailOf({ state: 'closed' }), stack)).toBeNull()
    expect(stackMergePlan(detailOf({ number: 9 }), stack)).toBeNull()
  })

  test('a detail read that did not ask about stacks defers to the stack read', () => {
    const stack = stackOf([layer(1), layer(2), layer(3)])
    expect(stackMergePlan(detailOf({ stack: undefined }), stack)?.layers).toHaveLength(3)
  })

  test('a layer without a head cannot be checked, so there are no heads to send', () => {
    expect(stackExpectedHeads([layer(1), layer(2, { headSha: undefined })])).toBeNull()
    const plan = stackMergePlan(detailOf(), stackOf([layer(1, { headSha: undefined }), layer(2), layer(3)]))
    expect(plan?.layers).toHaveLength(3)
    expect(plan?.expectedHeads).toBeNull()
  })

  test('a queued merge says so rather than claiming the layers landed', () => {
    const pullRequests = [detailOf({ number: 2 }), detailOf({ number: 3 })]
    expect(stackMergeOutcome({ status: 'queued', pullRequests })).toBe('2 pull requests added to the merge queue')
    expect(stackMergeOutcome({ status: 'merged', pullRequests: pullRequests.slice(1) })).toBe('1 pull request merged')
  })
})

describe('fork workflow approval', () => {
  test('runs are read only for an open fork pull request on a host that offers approval', () => {
    expect(readsPendingWorkflowRuns(detailOf({ isFork: true }))).toBe(true)
    expect(readsPendingWorkflowRuns(detailOf({ isFork: false }))).toBe(false)
    expect(readsPendingWorkflowRuns(detailOf({ isFork: true, state: 'merged' }))).toBe(false)
    expect(readsPendingWorkflowRuns(detailOf({ isFork: true, hostActions: ['merge'] }))).toBe(false)
  })

  test('only a viewer allowed to approve gets the action', () => {
    expect(mayApproveWorkflowRuns(detailOf({ isFork: true }))).toBe(true)
    expect(mayApproveWorkflowRuns(detailOf({ isFork: true, viewerActions: ['merge'] }))).toBe(false)
  })
})
