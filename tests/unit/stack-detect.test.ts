import { describe, expect, test } from 'bun:test'
import {
  ancestryCandidatePairs,
  buildStackGraph,
  invalidateStaleEdges,
  parseDeclaredParents,
  patchIdsAreSubset,
  stackPairKey,
  type StackPullRequestInput,
} from '../../src/main/git/stack-detect'
import { resolveStackDiffBase } from '../../src/renderer/contexts/stack-diff-base'
import type { StackGraph } from '../../src/shared/stack-types'

const detectedAt = '2026-07-15T00:00:00.000Z'

function pr(number: number, overrides: Partial<StackPullRequestInput> = {}): StackPullRequestInput {
  return {
    number,
    author: 'octocat',
    body: '',
    headSha: `head-${number}`,
    files: ['shared.ts'],
    baseRef: 'main',
    headRef: `feature-${number}`,
    ...overrides,
  }
}

describe('stack graph inference', () => {
  test('chooses the nearest ancestor so a chain has no transitive A → C edge', () => {
    const graph = buildStackGraph(
      [pr(1), pr(2), pr(3)],
      {
        ancestry: new Set([
          stackPairKey(1, 2),
          stackPairKey(1, 3),
          stackPairKey(2, 3),
        ]),
        patchIds: new Map(),
      },
      null,
      detectedAt,
    )

    expect(graph.edges).toEqual([
      { parent: 1, child: 2, source: 'ancestry' },
      { parent: 2, child: 3, source: 'ancestry' },
    ])
  })

  test('uses a strict patch-id subset for rebased chains', () => {
    expect(patchIdsAreSubset(new Set(['a']), new Set(['a', 'b']))).toBe(true)
    expect(patchIdsAreSubset(new Set(['a']), new Set(['a']))).toBe(false)
    expect(patchIdsAreSubset(new Set(), new Set(['a']))).toBe(false)

    const graph = buildStackGraph(
      [pr(10), pr(11)],
      {
        ancestry: new Set(),
        patchIds: new Map([
          [10, new Set(['patch-a'])],
          [11, new Set(['patch-a', 'patch-b'])],
        ]),
      },
      null,
      detectedAt,
    )
    expect(graph.edges).toEqual([{ parent: 10, child: 11, source: 'patchid' }])
  })

  test('uses a child base branch that names another PR head without file enrichment', () => {
    const graph = buildStackGraph(
      [pr(12, { headRef: 'stack-base' }), pr(13, { baseRef: 'stack-base', files: [] })],
      { ancestry: new Set(), patchIds: new Map() },
      null,
      detectedAt,
    )
    expect(graph.edges).toEqual([{ parent: 12, child: 13, source: 'declared' }])
  })

  test('only same-repository PR heads can match a child base branch', () => {
    const forkGraph = buildStackGraph(
      [pr(14, { headRef: 'main', isCrossRepository: true }), pr(15)],
      { ancestry: new Set(), patchIds: new Map() },
      null,
      detectedAt,
    )
    const sameRepoGraph = buildStackGraph(
      [pr(16, { headRef: 'stack-base', isCrossRepository: false }), pr(17, { baseRef: 'stack-base' })],
      { ancestry: new Set(), patchIds: new Map() },
      null,
      detectedAt,
    )

    expect(forkGraph.edges).toEqual([])
    expect(sameRepoGraph.edges).toEqual([{ parent: 16, child: 17, source: 'declared' }])
  })

  test('a paginated detection preserves cached relationships outside the current page', () => {
    const previous: StackGraph = {
      edges: [{ parent: 70, child: 71, source: 'ancestry' }],
      headShas: { 70: 'head-70', 71: 'head-71' },
      detectedAt,
    }
    const graph = buildStackGraph(
      [pr(1)],
      { ancestry: new Set(), patchIds: new Map() },
      previous,
      detectedAt,
      false,
    )
    expect(graph.edges).toContainEqual({ parent: 70, child: 71, source: 'ancestry' })
    expect(graph.headShas[71]).toBe('head-71')
  })

  test('parses Depends on prose and ordered stack tables without guessing from ordinary mentions', () => {
    expect(parseDeclaredParents('This depends on #42 before rollout.', 43)).toEqual([42])
    expect(parseDeclaredParents('Stack\n\n| PR | Note |\n| --- | --- |\n| #41 | base |\n| #42 | this PR |', 42)).toEqual([41])
    expect(parseDeclaredParents('Related to #42 and #43.', 44)).toEqual([])
  })

  test('manual intent survives re-detection and head movement while both PRs remain open', () => {
    const previous: StackGraph = {
      edges: [{ parent: 20, child: 21, source: 'manual' }],
      headShas: { 20: 'old-parent', 21: 'old-child' },
      detectedAt,
    }
    const graph = buildStackGraph(
      [pr(20, { headSha: 'new-parent' }), pr(21, { headSha: 'new-child' })],
      { ancestry: new Set(), patchIds: new Map() },
      previous,
      detectedAt,
    )
    expect(graph.edges).toEqual([{ parent: 20, child: 21, source: 'manual' }])
    expect(graph.headShas).toEqual({ 20: 'new-parent', 21: 'new-child' })
  })

  test('invalidates cached inferred edges when either head moves', () => {
    const previous: StackGraph = {
      edges: [{ parent: 30, child: 31, source: 'ancestry' }],
      headShas: { 30: 'parent-a', 31: 'child-a' },
      detectedAt,
    }
    expect(invalidateStaleEdges(previous, { 30: 'parent-b', 31: 'child-a' })).toEqual([])
    expect(invalidateStaleEdges(previous, { 30: 'parent-a', 31: 'child-a' })).toEqual(previous.edges)
  })

  test('drops a manual edge once its parent is no longer open', () => {
    const previous: StackGraph = {
      edges: [{ parent: 40, child: 41, source: 'manual' }],
      headShas: { 40: 'head-40', 41: 'head-41' },
      detectedAt,
    }
    const graph = buildStackGraph(
      [pr(41)],
      { ancestry: new Set(), patchIds: new Map() },
      previous,
      detectedAt,
    )
    expect(graph.edges).toEqual([])
  })

  test('a PR whose head already landed on the base branch is never an ancestry parent', () => {
    // PR 80's commits are on main, so every branch cut from newer main contains
    // its head. Without the containment filter the whole repo would appear
    // stacked on PR 80; ancestry between still-unlanded PRs must survive.
    const containedInMain = new Map([['main', new Set([80])]])
    const pairs = ancestryCandidatePairs([pr(80), pr(81), pr(82)], containedInMain)

    expect(pairs.has(stackPairKey(80, 81))).toBe(false)
    expect(pairs.has(stackPairKey(80, 82))).toBe(false)
    expect(pairs.has(stackPairKey(81, 82))).toBe(true)
    expect(pairs.has(stackPairKey(81, 80))).toBe(true)
  })

  test('leaves equally plausible patch-id parents unrelated', () => {
    const graph = buildStackGraph(
      [pr(50), pr(51), pr(52)],
      {
        ancestry: new Set(),
        patchIds: new Map([
          [50, new Set(['shared'])],
          [51, new Set(['shared'])],
          [52, new Set(['shared', 'child-only'])],
        ]),
      },
      null,
      detectedAt,
    )
    expect(graph.edges.filter((edge) => edge.child === 52)).toEqual([])
  })
})

describe('stack diff base', () => {
  test('uses the live parent head for an own-delta diff', () => {
    const graph: StackGraph = {
      edges: [{ parent: 60, child: 61, source: 'ancestry' }],
      headShas: { 60: 'parent-head', 61: 'child-head' },
      detectedAt,
    }
    expect(resolveStackDiffBase(graph, 61, 'main')).toEqual({
      kind: 'own-delta',
      ref: 'parent-head',
      parent: 60,
    })
  })

  test('falls back to the PR target after a parent edge disappears', () => {
    const graph: StackGraph = { edges: [], headShas: { 61: 'child-head' }, detectedAt }
    expect(resolveStackDiffBase(graph, 61, 'main')).toEqual({ kind: 'target', ref: 'main' })
  })
})
