import { describe, expect, test } from 'bun:test'
import type { TurnSnapshot } from '@solus/contracts/types'
import {
  diffScopeForReviewScope,
  reviewScopeKind,
  reviewScopeLabel,
} from '@solus/workspace-ui/components/diff/lib/review-header'

function turn(index: number): TurnSnapshot {
  return {
    index,
    fromTreeSha: 'from',
    toTreeSha: 'to',
    sha: 'sha',
    timestamp: 0,
    partial: false,
    userMessagePreview: '',
    filesChanged: 1,
    additions: 1,
    deletions: 0,
  }
}

describe('review scope picker', () => {
  test('an absent route scope is the branch review', () => {
    expect(reviewScopeKind(undefined)).toBe('branch')
  })

  test('a turn stays under Session, because the turn stepper owns the slice', () => {
    expect(reviewScopeKind({ kind: 'turn', index: 3 })).toBe('session')
    expect(reviewScopeKind({ kind: 'session' })).toBe('session')
  })

  test('a pull-request scope is fixed by its host and has no picker', () => {
    expect(reviewScopeKind({ kind: 'pr', baseSha: 'abc123' })).toBeNull()
  })

  test('choosing Branch clears the scope so the surface resolves the live base', () => {
    expect(diffScopeForReviewScope('branch')).toBeUndefined()
  })

  test('the trigger names the selected turn by its position, not its snapshot index', () => {
    // Snapshot indexes can skip; the reader counts turns from one.
    const turns = [turn(0), turn(2), turn(5)]
    expect(reviewScopeLabel('session', turns, 2)).toBe('Turn 2/3')
    expect(reviewScopeLabel('session', turns, null)).toBe('Session')
    expect(reviewScopeLabel('branch', turns, null)).toBe('Branch')
  })

  test('each choice reads back as the same choice', () => {
    for (const kind of ['branch', 'session', 'working-tree'] as const) {
      expect(reviewScopeKind(diffScopeForReviewScope(kind))).toBe(kind)
    }
  })
})
